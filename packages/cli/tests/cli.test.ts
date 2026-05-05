import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { runBaselineInit, runBaselineUpdate } from "../src/commands/baseline.js";
import { runCheck } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runInit } from "../src/commands/init.js";
import { runLock } from "../src/commands/lock.js";
import { createProgram, runCli } from "../src/index.js";

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

describe("stele CLI", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("init creates the default config, contract scaffold, checker dir, and pytest fixture", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python" });

    await expect(readJson(join(projectDir, STELE_CONFIG_FILE))).resolves.toEqual(DEFAULT_CONFIG);
    await expect(readFile(join(projectDir, "contract", "main.stele"), "utf8")).resolves.toContain("(invariant");
    await expect(readFile(join(projectDir, "contract", "checker_impls", ".gitkeep"), "utf8")).resolves.toBe("");
    const conftest = await readFile(join(projectDir, "tests", "contract", "conftest.py"), "utf8");
    expect(conftest).toContain("def stele_default(value, fallback):");
    expect(conftest).toContain("def stele_context_or_skip(**values):");
    expect(conftest).toContain("@pytest.fixture\ndef stele_context():\n    return {}\n");
    expect(conftest).toContain("@pytest.fixture\ndef stele_sandbox():\n    return nullcontext()\n");
  });

  it("init does not overwrite existing user files", async () => {
    const projectDir = await createTempDir();
    const existingConfig = { ...DEFAULT_CONFIG, targetLanguage: "python" };

    await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(existingConfig, null, 2)}\n`);
    await writeProjectFile(projectDir, "contract/main.stele", "(invariant USER_RULE\n  (severity high)\n  (description \"keep me\")\n  (assert (eq 1 1)))\n");
    await writeProjectFile(projectDir, "tests/contract/conftest.py", "# custom fixture\n");

    await runInit(projectDir, { language: "python" });

    await expect(readJson(join(projectDir, STELE_CONFIG_FILE))).resolves.toEqual(existingConfig);
    await expect(readFile(join(projectDir, "contract", "main.stele"), "utf8")).resolves.toBe(
      "(invariant USER_RULE\n  (severity high)\n  (description \"keep me\")\n  (assert (eq 1 1)))\n",
    );
    await expect(readFile(join(projectDir, "tests", "contract", "conftest.py"), "utf8")).resolves.toBe("# custom fixture\n");
  });

  it("init rejects unsupported languages without writing scaffold files", async () => {
    const projectDir = await createTempDir();

    await expect(runInit(projectDir, { language: "ruby" })).rejects.toThrow(/unsupported language/i);

    await expect(pathExists(join(projectDir, STELE_CONFIG_FILE))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, "contract", "main.stele"))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, "tests", "contract", "conftest.py"))).resolves.toBe(false);
  });

  it("init only treats missing files as creatable and surfaces stable filesystem errors", async () => {
    const projectDir = await createTempDir();
    await mkdir(join(projectDir, STELE_CONFIG_FILE), { recursive: true });

    await expect(runInit(projectDir, { language: "python" })).rejects.toThrow(/EISDIR|illegal operation on a directory/i);
    await expect(pathExists(join(projectDir, "contract", "main.stele"))).resolves.toBe(false);
  });

  it("init scaffold supports scenario-backed pytest generation and execution out of the box", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python" });
    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund"',
        '      (body (object (name (gen unique-name "fund")))))',
        "    (capture fund))",
        "  (capture-state pnl",
        '    (call "tests.contract_scenarios:get_pnl"',
        "      (body (object (fund-id (ref fund id)))))))",
        "(invariant FUND_PNL_VALID",
        "  (uses-scenario fund-pnl-flow)",
        "  (severity high)",
        '  (description "Generated fund PnL remains valid.")',
        "  (assert (gt (path pnl value) 0)))",
      ].join("\n"),
    );
    await writeProjectFile(projectDir, "tests/__init__.py", "");
    await writeProjectFile(
      projectDir,
      "tests/contract_scenarios.py",
      [
        "def create_fund(body, stele_context):",
        '    return {"id": "fund-123", "name": body["name"]}',
        "",
        "",
        "def get_pnl(body, stele_context):",
        '    assert body["fund-id"] == "fund-123"',
        '    return {"value": 5}',
      ].join("\n"),
    );

    await runGenerate(projectDir, { force: false });
    const result = await runContractPytest(projectDir);

    expect(result.stdout).toContain("1 passed");
  });

  it("generate writes canonical Python files without writing a manifest", async () => {
    const projectDir = await createFixtureProject();

    const summary = await runGenerate(projectDir, { force: false });

    await expect(readFile(join(projectDir, "tests", "contract", "__init__.py"), "utf8")).resolves.toBe("");
    await expect(readFile(join(projectDir, "tests", "contract", "_stele_runtime.py"), "utf8")).resolves.toContain(
      "def stele_get_path",
    );
    await expect(readFile(join(projectDir, "tests", "contract", "test_contract.py"), "utf8")).resolves.toContain(
      "def test_ROOT_RULE",
    );

    await expect(pathExists(join(projectDir, "contract", ".manifest.json"))).resolves.toBe(false);
    expect(summary).toEqual({
      generatedDir: "tests/contract",
      generatedFileCount: 3,
    });
  });

  it("generate includes scenario runtime calls and sandbox fixture dependencies for scenario-backed invariants", async () => {
    const projectDir = await createFixtureProject();
    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      [
        "(scenario fund-pnl-flow",
        "  (sandbox transactional)",
        "  (executor python-import)",
        "  (step setup-fund",
        '    (call "tests.contract_scenarios:create_fund")',
        "    (capture fund))",
        "  (capture-state pnl",
        '    (call "tests.contract_scenarios:get_pnl"',
        "      (body (object (fund-id (ref fund id)))))))",
        "(invariant FUND_PNL_VALID",
        "  (uses-scenario fund-pnl-flow)",
        "  (severity high)",
        '  (description "Generated fund PnL remains valid.")',
        "  (assert (gt (path pnl value) 0)))",
      ].join("\n"),
    );

    await runGenerate(projectDir, { force: false });

    const generated = await readFile(join(projectDir, "tests", "contract", "test_contract.py"), "utf8");
    expect(generated).toContain("def test_FUND_PNL_VALID(stele_context, stele_sandbox):");
    expect(generated).toContain("stele_scenario_context = stele_run_scenario(");
    expect(generated).toContain('stele_assert_context = stele_merge_contexts(stele_context, stele_scenario_context)');
  });

  it("generate stays manifest-neutral when nothing changed", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, { force: false });
    await runGenerate(projectDir, { force: false });
    await expect(pathExists(join(projectDir, "contract", ".manifest.json"))).resolves.toBe(false);
  });

  it("generate stale-layout errors name the changed and extra generated files", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, { force: false });
    await writeProjectFile(projectDir, "tests/contract/test_contract.py", "# tampered\n");
    await writeProjectFile(projectDir, "tests/contract/extra.py", "# extra\n");

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(
      /Changed: tests\/contract\/test_contract\.py\. Extra: tests\/contract\/extra\.py\./,
    );
  });

  it("generate rejects an entry path outside the project root and writes nothing", async () => {
    const projectDir = await createFixtureProject();
    const externalDir = await createTempDir();
    const externalEntry = join(externalDir, "outside.stele");

    await writeProjectFile(
      externalDir,
      "outside.stele",
      [
        "(invariant OUTSIDE_RULE",
        "  (severity high)",
        '  (description "Outside contract.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );
    await writeConfig(projectDir, { entry: externalEntry });

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/project-relative|inside the project root/i);
    await expect(pathExists(join(projectDir, "tests", "contract", "test_contract.py"))).resolves.toBe(false);
    await expect(pathExists(join(projectDir, "contract", ".manifest.json"))).resolves.toBe(false);
  });

  it("generate rejects parent-traversing manifest paths and does not write outside the project", async () => {
    const projectDir = await createFixtureProject();
    const outsideManifestDirName = `outside-manifest-${projectDir.split(/[\\/]/).at(-1)}`;
    const outsideManifestDir = join(projectDir, "..", outsideManifestDirName);
    const outsideManifestPath = join(outsideManifestDir, ".manifest.json");

    await writeConfig(projectDir, { manifestPath: `../${outsideManifestDirName}/.manifest.json` });

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/project-relative|inside the project root/i);
    await expect(pathExists(outsideManifestPath)).resolves.toBe(false);
    await expect(pathExists(join(projectDir, "contract", ".manifest.json"))).resolves.toBe(false);
  });

  it("generate rejects a root-level manifestPath and does not write the manifest", async () => {
    const projectDir = await createFixtureProject();
    await writeConfig(projectDir, { manifestPath: ".manifest.json" });

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/manifestPath|first-level project directory|project-relative/i);
    await expect(pathExists(join(projectDir, ".manifest.json"))).resolves.toBe(false);
  });

  it("generate rejects a nested manifestPath below a first-level project directory", async () => {
    const projectDir = await createFixtureProject();
    await writeConfig(projectDir, { manifestPath: "contract/nested/.manifest.json" });

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/manifestPath|first-level project directory|project-relative/i);
    await expect(pathExists(join(projectDir, "contract", "nested", ".manifest.json"))).resolves.toBe(false);
  });

  it("generate rejects Windows drive-relative config paths", async () => {
    const projectDir = await createFixtureProject();
    await writeConfig(projectDir, { generatedDir: "C:outside\\generated" });

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/project-relative|inside the project root/i);
  });

  it("generate fails closed on malformed protected config and does not proceed", async () => {
    for (const protectedValue of [42, [42], [""], ["/contract/**"], ["C:\\contract\\**"], ["C:contract\\**"], ["\\\\server\\share"], ["../contract/**"], ["contract/../secrets/**"], ["docs/[a-z].md"]]) {
      const projectDir = await createFixtureProject();
      await writeConfig(projectDir, { protected: protectedValue });

      await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/protected|project-relative|unsupported glob/i);
      await expect(pathExists(join(projectDir, "tests", "contract", "test_contract.py"))).resolves.toBe(false);
      await expect(pathExists(join(projectDir, "contract", ".manifest.json"))).resolves.toBe(false);
    }
  });

  it("generate, lock, and check all fail closed on whitespace-only protected config", async () => {
    const projectDir = await createFixtureProject();
    const manifestPath = join(projectDir, "contract", ".manifest.json");

    await writeConfig(projectDir, { protected: ["   "] });
    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/protected/i);
    await expect(pathExists(join(projectDir, "tests", "contract", "test_contract.py"))).resolves.toBe(false);
    await expect(pathExists(manifestPath)).resolves.toBe(false);

    await writeConfig(projectDir, { protected: DEFAULT_CONFIG.protected });
    await runGenerate(projectDir, { force: false });
    await runLock(projectDir, { reason: "initial baseline" });
    const manifestBefore = await readFile(manifestPath, "utf8");

    await writeConfig(projectDir, { protected: ["   "] });
    await expect(runLock(projectDir, { reason: "whitespace should fail" })).rejects.toThrow(/protected/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);

    await expect(runCheck(projectDir)).rejects.toThrow(/protected/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
  });

  it("lock fails closed on malformed protected config and does not write or refresh the manifest", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
    const manifestPath = join(projectDir, "contract", ".manifest.json");

    await writeConfig(projectDir, { protected: [42] });
    await expect(runLock(projectDir, { reason: "should fail" })).rejects.toThrow(/protected/i);
    await expect(pathExists(manifestPath)).resolves.toBe(false);

    await writeConfig(projectDir, { protected: DEFAULT_CONFIG.protected });
    await runLock(projectDir, { reason: "initial baseline" });
    const manifestBefore = await readFile(manifestPath, "utf8");

    await writeConfig(projectDir, { protected: ["../contract/**"] });
    await expect(runLock(projectDir, { reason: "should still fail" })).rejects.toThrow(/protected|project-relative/i);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
  });

  it("check fails closed on malformed protected config and rejects stale manifest bypasses", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial baseline");

    await writeConfig(projectDir, { protected: [42] });
    await expect(runCheck(projectDir)).rejects.toThrow(/protected/i);

    await writeConfig(projectDir, { protected: ["docs/[a-z].md"] });
    await expect(runCheck(projectDir)).rejects.toThrow(/protected|unsupported glob/i);
  });

  it("valid custom brace protected patterns remain accepted", async () => {
    const projectDir = await createFixtureProject({
      protected: ["docs/{api,other}/**/*"],
    });
    await writeProjectFile(projectDir, "docs/api/readme.txt", "# api\n");
    await writeProjectFile(projectDir, "docs/other/readme.txt", "# other\n");

    await runGenerate(projectDir, { force: false });
    await runLock(projectDir, { reason: "brace pattern baseline" });

    const manifest = await readJson(join(projectDir, "contract", ".manifest.json"));
    expect(Object.keys(manifest.protected_files)).toContain("docs/api/readme.txt");
    expect(Object.keys(manifest.protected_files)).toContain("docs/other/readme.txt");
  });

  it("explicit empty protected config intentionally allows generate, lock, and check with no protected file entries", async () => {
    const projectDir = await createFixtureProject({
      protected: [],
    });
    await writeProjectFile(projectDir, "docs/guide.md", "# guide\n");

    await runGenerate(projectDir, { force: false });
    await runLock(projectDir, { reason: "empty protected baseline" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    const manifest = await readJson(join(projectDir, "contract", ".manifest.json"));
    expect(Object.keys(manifest.protected_files)).toEqual([]);
  });

  it("check fails after generate until the manifest is explicitly locked", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, { force: false });
    await expect(runCheck(projectDir)).rejects.toThrow(/manifest/i);

    await runLock(projectDir, { reason: "initial contract baseline" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();
  });

  it("check passes after lock and does not modify project files", async () => {
    const projectDir = await createFixtureProject();

    await runGenerateAndLock(projectDir, "initial contract baseline");
    const before = await snapshotProject(projectDir);
    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    const after = await snapshotProject(projectDir);
    expect(after).toEqual(before);
  });

  it("check fails when a generated file changes", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "tests/contract/test_contract.py", "# tampered\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("baseline-update requires a non-empty reason", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");

    await expect(runBaselineUpdate(projectDir, { reason: "" })).rejects.toThrow(/reason/i);
    await expect(runBaselineUpdate(projectDir, { reason: "   " })).rejects.toThrow(/reason/i);
  });

  it("check fails with manifest drift after the baseline file is edited directly", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");
    await runBaselineInit(projectDir, { reason: "initial legacy adoption" });

    const baseline = await readJson(join(projectDir, "contract", ".baseline.json"));
    baseline.reason = "manually edited";
    await writeProjectFile(projectDir, "contract/.baseline.json", `${JSON.stringify(baseline, null, 2)}\n`);

    await expect(runCheck(projectDir)).rejects.toThrow(/manifest|protected/i);
  });

  it("check fails when a generated file is missing", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await rm(join(projectDir, "tests", "contract", "_stele_runtime.py"));

    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check fails when an extra generated file appears", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "tests/contract/extra.py", "# extra\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check ignores Python cache artifacts under generated output but still fails on undeclared source files", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "tests/contract/__pycache__/test_contract.cpython-313-pytest-9.0.2.pyc", "pyc");
    await writeProjectFile(projectDir, "tests/contract/__pycache__/conftest.cpython-313-pytest-9.0.2.pyc", "pyc");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/custom_checker.cpython-313.pyc", "pyc");

    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    await writeProjectFile(projectDir, "tests/contract/extra.py", "# extra\n");
    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("generate does not ignore protected source files just because they live in __pycache__ directories", async () => {
    const projectDir = await createFixtureProject({
      protected: ["contract/**", "tests/contract/**/*"],
    });
    await writeProjectFile(projectDir, "contract/__pycache__/evil.py", "print('tracked source')\n");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/evil.py", "print('tracked checker source')\n");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/ignored.pyc", "pyc");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/ignored.pyo", "pyo");

    await runGenerate(projectDir, { force: false });
    await runLock(projectDir, { reason: "capture protected source inside __pycache__" });

    const manifest = await readJson(join(projectDir, "contract", ".manifest.json"));
    expect(Object.keys(manifest.protected_files)).toContain("contract/__pycache__/evil.py");
    expect(Object.keys(manifest.protected_files)).toContain("contract/checker_impls/__pycache__/evil.py");
    expect(Object.keys(manifest.protected_files)).not.toContain("contract/checker_impls/__pycache__/ignored.pyc");
    expect(Object.keys(manifest.protected_files)).not.toContain("contract/checker_impls/__pycache__/ignored.pyo");
  });

  it("check does not ignore source directories whose names merely contain __pycache__", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "contract/checker_impls/not__pycache__/shadow_checker.py", "def shadow_checker(context):\n    return True\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/new\/unlocked protected files|protected/i);
  });

  it("generate, check, and lock honor custom protected globs for user files", async () => {
    const projectDir = await createFixtureProject({
      protected: [...DEFAULT_CONFIG.protected, "docs/**/*.md"],
    });
    await writeProjectFile(projectDir, "docs/guide.md", "# guide\n");

    await runGenerate(projectDir, { force: false });
    await runLock(projectDir, { reason: "initial docs baseline" });

    const manifestPath = join(projectDir, "contract", ".manifest.json");
    const manifest = await readJson(manifestPath);
    expect(Object.keys(manifest.protected_files)).toContain("docs/guide.md");
    expect(Object.keys(manifest.protected_files)).not.toContain("contract/.manifest.json");

    await writeProjectFile(projectDir, "docs/guide.md", "# guide updated\n");
    await expect(runCheck(projectDir)).rejects.toThrow(/manifest|protected/i);

    await runLock(projectDir, { reason: "approved docs update" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    await writeProjectFile(projectDir, "docs/new.md", "# new\n");
    await expect(runCheck(projectDir)).rejects.toThrow(/new\/unlocked protected files|protected/i);
  });

  it("check fails on a new protected checker file until lock refreshes the manifest", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "contract/checker_impls/new_checker.py", "def new_checker(context):\n    return True\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/new\/unlocked protected files|protected/i);

    await runLock(projectDir, { reason: "approved checker addition" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();
  });

  it("check fails on a new protected cdl file before lock", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(
      projectDir,
      "contract/extra.stele",
      [
        "(invariant EXTRA_RULE",
        "  (severity high)",
        '  (description "Additional protected contract file.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    await expect(runCheck(projectDir)).rejects.toThrow(/new\/unlocked protected files|protected/i);
  });

  it("check fails when a manifest-protected file changes", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "contract/checker_impls/custom_checker.py", "def custom_checker(context):\n    return False\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/manifest|protected/i);
  });

  it("generate fails when a protected unimported stele file exists, even if invalid", async () => {
    const projectDir = await createFixtureProject();
    await writeProjectFile(projectDir, "contract/invalid.stele", "(invariant BROKEN\n");

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/import|entry|protected/i);
  });

  it("lock and check fail when a new protected unimported stele file exists", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "contract/invalid.stele", "(invariant BROKEN\n");

    await expect(runLock(projectDir, { reason: "approved invalid file" })).rejects.toThrow(/import|entry|protected/i);
    await expect(runCheck(projectDir)).rejects.toThrow(/import|entry|protected|new\/unlocked/i);
  });

  it("generate fails when a protected unimported but valid stele file exists", async () => {
    const projectDir = await createFixtureProject();
    await writeProjectFile(
      projectDir,
      "contract/extra.stele",
      [
        "(invariant EXTRA_RULE",
        "  (severity high)",
        '  (description "Valid but unimported protected file.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/import|entry|protected/i);
  });

  const windowsReachabilityCase = process.platform === "win32" ? it : it.skip;

  windowsReachabilityCase("generate accepts case-insensitive imported protected stele files on Windows", async () => {
    const projectDir = await createTempDir();

    await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      ['(import "./Sub.stele")', "(invariant ROOT_RULE", "  (severity high)", '  (description "Root rule.")', "  (assert (eq 1 1)))"].join(
        "\n",
      ),
    );
    await writeProjectFile(
      projectDir,
      "contract/sub.stele",
      ['(invariant SUB_RULE', "  (severity high)", '  (description "Imported with different case.")', "  (assert (eq 1 1)))"].join(
        "\n",
      ),
    );
    await writeProjectFile(projectDir, "contract/checker_impls/.gitkeep", "");
    await writeProjectFile(
      projectDir,
      "tests/contract/conftest.py",
      "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
    );

    await expect(runGenerate(projectDir, { force: false })).resolves.toMatchObject({
      generatedDir: "tests/contract",
      generatedFileCount: 3,
    });
    await runLock(projectDir, { reason: "windows case-insensitive import baseline" });

    const manifest = await readJson(join(projectDir, "contract", ".manifest.json"));
    expect(Object.keys(manifest.protected_files)).toContain("contract/sub.stele");
  });

  it("generate --force does not refresh the manifest after an approved checker change until lock runs", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial checker baseline");

    const manifestPath = join(projectDir, "contract", ".manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");

    await writeProjectFile(
      projectDir,
      "contract/checker_impls/custom_checker.py",
      "def custom_checker(context):\n    return {\"passed\": True, \"message\": \"updated\"}\n",
    );
    await runGenerate(projectDir, { force: true });

    await expect(runCheck(projectDir)).rejects.toThrow();
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
    await runLock(projectDir, { reason: "approved checker update" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    const manifestAfter = await readFile(manifestPath, "utf8");
    expect(manifestAfter).not.toBe(manifestBefore);
  });

  it("lock preserves manifest content when nothing changed", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);

    const manifestPath = join(projectDir, "contract", ".manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");

    await runLock(projectDir, { reason: "no-op refresh" });

    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
  });

  it("generate --force stays manifest-neutral and lock ignores Python cache artifacts from generated or checker directories", async () => {
    const projectDir = await createFixtureProject();
    await writeProjectFile(projectDir, "tests/contract/__pycache__/test_contract.cpython-313-pytest-9.0.2.pyc", "pyc");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/custom_checker.cpython-313.pyc", "pyc");

    await runGenerate(projectDir, { force: true });
    await expect(pathExists(join(projectDir, "contract", ".manifest.json"))).resolves.toBe(false);
    await runLock(projectDir, { reason: "ignore cache artifacts" });

    const manifest = await readJson(join(projectDir, "contract", ".manifest.json"));
    expect(Object.keys(manifest.protected_files)).toEqual([
      "contract/checker_impls/custom_checker.py",
      "contract/main.stele",
      "tests/contract/__init__.py",
      "tests/contract/_stele_runtime.py",
      "tests/contract/conftest.py",
      "tests/contract/test_contract.py",
    ]);
  });

  it("generate fails when protected scanning encounters a non-regular checker entry", async () => {
    const projectDir = await createFixtureProject();
    const targetDir = join(projectDir, "linked-target");
    await mkdir(targetDir, { recursive: true });
    await writeProjectFile(projectDir, "linked-target/ignored.py", "# ignored\n");

    const createdLink = await tryCreateNonRegularEntry(targetDir, join(projectDir, "contract", "checker_impls", "linked"));

    if (!createdLink) {
      return;
    }

    await expect(runGenerate(projectDir, { force: false })).rejects.toThrow(/non-regular|symbolic link|symlink/i);
  });

  it("lock does not add Python cache artifacts to the manifest when they already exist", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
    await writeProjectFile(projectDir, "tests/contract/__pycache__/test_contract.cpython-313-pytest-9.0.2.pyc", "pyc");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/custom_checker.cpython-313.pyc", "pyc");

    await runLock(projectDir, { reason: "refresh manifest" });

    const manifest = await readJson(join(projectDir, "contract", ".manifest.json"));
    expect(Object.keys(manifest.protected_files)).toEqual([
      "contract/checker_impls/custom_checker.py",
      "contract/main.stele",
      "tests/contract/__init__.py",
      "tests/contract/_stele_runtime.py",
      "tests/contract/conftest.py",
      "tests/contract/test_contract.py",
    ]);
  });

  it("CLI entry parses commands and forwards cwd and options", async () => {
    const handlers = {
      check: vi.fn(async () => undefined),
      baselineInit: vi.fn(async () => undefined),
      baselineUpdate: vi.fn(async () => undefined),
      generate: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
    };
    const program = createProgram({
      cwd: () => "E:/tmp/project",
      runCheck: handlers.check,
      runBaselineInit: handlers.baselineInit,
      runBaselineUpdate: handlers.baselineUpdate,
      runGenerate: handlers.generate,
      runLock: handlers.lock,
      runInit: handlers.init,
    });

    await program.parseAsync(["node", "stele", "check", "--json", "--report-file", ".stele/reports/last.json", "--diff-from", "main"]);
    await program.parseAsync(["node", "stele", "baseline-init", "--reason", "initial legacy adoption"]);
    await program.parseAsync(["node", "stele", "baseline-update", "--reason", "approved legacy fix"]);
    await program.parseAsync(["node", "stele", "generate", "--force"]);
    await program.parseAsync(["node", "stele", "lock", "--reason", "approved"]);
    await program.parseAsync(["node", "stele", "init", "--language", "python"]);

    expect(handlers.check).toHaveBeenCalledWith("E:/tmp/project", {
      diffFrom: "main",
      json: true,
      reportFile: ".stele/reports/last.json",
    });
    expect(handlers.baselineInit).toHaveBeenCalledWith("E:/tmp/project", { reason: "initial legacy adoption" });
    expect(handlers.baselineUpdate).toHaveBeenCalledWith("E:/tmp/project", { reason: "approved legacy fix" });
    expect(handlers.generate).toHaveBeenCalledWith("E:/tmp/project", { force: true });
    expect(handlers.lock).toHaveBeenCalledWith("E:/tmp/project", { reason: "approved" });
    expect(handlers.init).toHaveBeenCalledWith("E:/tmp/project", { language: "python" });
  });

  it("CLI lock and check print success summaries for operators", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();
    const originalExitCode = process.exitCode;

    await runGenerate(projectDir, { force: false });
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;

    await runCli(["node", "stele", "lock", "--reason", "initial baseline"]);
    await runCli(["node", "stele", "check"]);

    expect(process.exitCode).toBe(0);
    expect(stdout.read()).toContain("OK manifest locked: contract/.manifest.json (1 invariant, 6 protected files).");
    expect(stdout.read()).toContain("OK 1 invariant checked; 3 generated files and 6 protected files verified.");
    process.exitCode = originalExitCode;
  });

  it("CLI generate prints a success summary for operators", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();
    const originalExitCode = process.exitCode;

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "generate"]);

    expect(process.exitCode).toBe(0);
    expect(stdout.read()).toContain("OK generated 3 files in tests/contract.");
    process.exitCode = originalExitCode;
  });

  it("CLI prints the package version through npm-safe version entry points", async () => {
    const stdout = captureStdout();

    await createProgram().exitOverride().parseAsync(["node", "stele", "version"]);
    await createProgram().exitOverride().parseAsync(["node", "stele", "--stele-version"]);

    expect(stdout.read()).toBe("0.1.0\n0.1.0\n");
  });

  it("CLI exits with code 2 when generated files are tampered", async () => {
    const projectDir = await createFixtureProject();
    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "tests/contract/test_contract.py", "# tampered\n");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "check"]);

    expect(process.exitCode).toBe(2);
    expect(stderr.read()).toContain("Generated files do not match the contract");
    process.exitCode = originalExitCode;
  });

  it("CLI check --json prints a structured violation report to stdout on generated drift", async () => {
    const projectDir = await createFixtureProject();
    const stdout = captureStdout();
    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "tests/contract/test_contract.py", "# tampered\n");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "check", "--json"]);

    const report = JSON.parse(stdout.read()) as {
      ok: boolean;
      command: string;
      violations: Array<{
        rule_id: string;
        rule_kind: string;
        fingerprint: string;
        cause: { changed?: string[] };
      }>;
    };

    expect(process.exitCode).toBe(2);
    expect(stderr.read()).toBe("");
    expect(report.ok).toBe(false);
    expect(report.command).toBe("check");
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]).toMatchObject({
      rule_id: "stele.check.generated_drift",
      rule_kind: "generated_drift",
      cause: {
        changed: ["tests/contract/test_contract.py"],
      },
    });
    expect(report.violations[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    process.exitCode = originalExitCode;
  });

  it("CLI exits with code 3 when protected files drift without lock", async () => {
    const projectDir = await createFixtureProject();
    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "contract/checker_impls/custom_checker.py", "def custom_checker(context):\n    return False\n");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "check"]);

    expect(process.exitCode).toBe(3);
    expect(stderr.read()).toContain("Manifest verification failed");
    process.exitCode = originalExitCode;
  });

  it("CLI check writes a JSON report file even when protected files drift", async () => {
    const projectDir = await createFixtureProject();
    const stderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runGenerateAndLock(projectDir);
    await writeProjectFile(projectDir, "contract/checker_impls/custom_checker.py", "def custom_checker(context):\n    return False\n");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "check", "--report-file", ".stele/reports/last.json"]);

    const report = await readJson(join(projectDir, ".stele", "reports", "last.json"));

    expect(process.exitCode).toBe(3);
    expect(stderr.read()).toContain("Manifest verification failed");
    expect(report).toMatchObject({
      ok: false,
      command: "check",
      violations: [
        {
          rule_id: "stele.check.manifest_drift",
          rule_kind: "manifest_drift",
          cause: {
            changed: ["contract/checker_impls/custom_checker.py"],
          },
        },
      ],
    });
    process.exitCode = originalExitCode;
  });

  it("generate --force does not refresh the manifest after a contract change until lock runs", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");

    const manifestPath = join(projectDir, "contract", ".manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");
    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      [
        "(invariant ROOT_RULE",
        "  (severity high)",
        '  (description "Root rules should generate pytest output after approval.")',
        "  (assert (eq 1 1)))",
      ].join("\n"),
    );

    await runGenerate(projectDir, { force: true });

    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
    await expect(runCheck(projectDir)).rejects.toThrow(/manifest contract hash|manifest/i);

    await runLock(projectDir, { reason: "approved contract update" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();
    await expect(readFile(manifestPath, "utf8")).resolves.not.toBe(manifestBefore);
  });
});

async function createFixtureProject(configOverrides: Partial<typeof DEFAULT_CONFIG> = {}): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify({ ...DEFAULT_CONFIG, ...configOverrides }, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(invariant ROOT_RULE",
      "  (severity high)",
      '  (description "Root rules should generate pytest output.")',
      "  (assert (eq 1 1)))",
    ].join("\n"),
  );
  await writeProjectFile(
    projectDir,
    "contract/checker_impls/custom_checker.py",
    "def custom_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );

  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeConfig(
  projectDir: string,
  overrides: Partial<Omit<typeof DEFAULT_CONFIG, "protected">> & { protected?: unknown },
): Promise<void> {
  const config = {
    ...(await readJson(join(projectDir, STELE_CONFIG_FILE))),
    ...overrides,
  };
  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

async function runGenerateAndLock(projectDir: string, reason = "approved baseline"): Promise<void> {
  await runGenerate(projectDir, { force: false });
  await runLock(projectDir, { reason });
}

async function snapshotProject(projectDir: string): Promise<Record<string, string>> {
  const files = await walkFiles(projectDir);
  const entries = await Promise.all(
    files.map(async (fullPath) => [fullPath.slice(projectDir.length + 1).replaceAll("\\", "/"), await readFile(fullPath, "utf8")] as const),
  );

  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

async function walkFiles(directory: string): Promise<string[]> {
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    directoryEntries.map(async (entry) => {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }

      if (entry.isFile()) {
        return [fullPath];
      }

      return [];
    }),
  );

  return nested.flat().sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function tryCreateNonRegularEntry(targetDirectory: string, linkPath: string): Promise<boolean> {
  for (const type of ["junction", "dir"] as const) {
    try {
      await symlink(targetDirectory, linkPath, type);
      return true;
    } catch (error) {
      if (!isSymlinkPermissionError(error)) {
        throw error;
      }
    }
  }

  return false;
}

function isSymlinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES" || error.code === "UNKNOWN");
}

async function runContractPytest(projectDir: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("python", ["-m", "pytest", "tests/contract", "-q"], {
    cwd: projectDir,
    windowsHide: true,
  });
}

function captureStderr(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  return {
    read: () => chunks.join(""),
  };
}

function captureStdout(): { read(): string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return {
    read: () => chunks.join(""),
  };
}
