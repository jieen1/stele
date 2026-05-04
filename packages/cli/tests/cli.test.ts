import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { runCheck } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runInit } from "../src/commands/init.js";
import { runLock } from "../src/commands/lock.js";
import { createProgram } from "../src/index.js";

const tempDirs: string[] = [];

describe("stele CLI", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("init creates the default config, contract scaffold, checker dir, and pytest fixture", async () => {
    const projectDir = await createTempDir();

    await runInit(projectDir, { language: "python" });

    await expect(readJson(join(projectDir, STELE_CONFIG_FILE))).resolves.toEqual(DEFAULT_CONFIG);
    await expect(readFile(join(projectDir, "contract", "main.stele"), "utf8")).resolves.toContain("(invariant");
    await expect(readFile(join(projectDir, "contract", "checker_impls", ".gitkeep"), "utf8")).resolves.toBe("");
    await expect(readFile(join(projectDir, "tests", "contract", "conftest.py"), "utf8")).resolves.toBe(
      "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
    );
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

  it("generate writes canonical Python files and a manifest", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, { force: false });

    await expect(readFile(join(projectDir, "tests", "contract", "__init__.py"), "utf8")).resolves.toBe("");
    await expect(readFile(join(projectDir, "tests", "contract", "_stele_runtime.py"), "utf8")).resolves.toContain(
      "def stele_get_path",
    );
    await expect(readFile(join(projectDir, "tests", "contract", "test_contract.py"), "utf8")).resolves.toContain(
      "def test_ROOT_RULE",
    );

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

  it("check passes after generate and does not modify project files", async () => {
    const projectDir = await createFixtureProject();

    await runGenerate(projectDir, { force: false });
    const before = await snapshotProject(projectDir);

    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    const after = await snapshotProject(projectDir);
    expect(after).toEqual(before);
  });

  it("check fails when a generated file changes", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
    await writeProjectFile(projectDir, "tests/contract/test_contract.py", "# tampered\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check fails when a generated file is missing", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
    await rm(join(projectDir, "tests", "contract", "_stele_runtime.py"));

    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check fails when an extra generated file appears", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
    await writeProjectFile(projectDir, "tests/contract/extra.py", "# extra\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check ignores Python cache artifacts under generated output but still fails on undeclared source files", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
    await writeProjectFile(projectDir, "tests/contract/__pycache__/test_contract.cpython-313-pytest-9.0.2.pyc", "pyc");
    await writeProjectFile(projectDir, "tests/contract/__pycache__/conftest.cpython-313-pytest-9.0.2.pyc", "pyc");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/custom_checker.cpython-313.pyc", "pyc");

    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    await writeProjectFile(projectDir, "tests/contract/extra.py", "# extra\n");
    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check fails on a new protected checker file until lock refreshes the manifest", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
    await writeProjectFile(projectDir, "contract/checker_impls/new_checker.py", "def new_checker(context):\n    return True\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/new\/unlocked protected files|protected/i);

    await runLock(projectDir, { reason: "approved checker addition" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();
  });

  it("check fails on a new protected cdl file before lock", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });
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
    await runGenerate(projectDir, { force: false });
    await writeProjectFile(projectDir, "contract/checker_impls/custom_checker.py", "def custom_checker(context):\n    return False\n");

    await expect(runCheck(projectDir)).rejects.toThrow(/manifest|protected/i);
  });

  it("lock refreshes the manifest after an approved checker change so check passes again", async () => {
    const projectDir = await createFixtureProject();
    await runGenerate(projectDir, { force: false });

    const manifestPath = join(projectDir, "contract", ".manifest.json");
    const manifestBefore = await readFile(manifestPath, "utf8");

    await writeProjectFile(
      projectDir,
      "contract/checker_impls/custom_checker.py",
      "def custom_checker(context):\n    return {\"passed\": True, \"message\": \"updated\"}\n",
    );

    await expect(runCheck(projectDir)).rejects.toThrow();
    await runLock(projectDir, { reason: "approved checker update" });
    await expect(runCheck(projectDir)).resolves.toBeUndefined();

    const manifestAfter = await readFile(manifestPath, "utf8");
    expect(manifestAfter).not.toBe(manifestBefore);
  });

  it("generate --force does not lock Python cache artifacts from generated or checker directories", async () => {
    const projectDir = await createFixtureProject();
    await writeProjectFile(projectDir, "tests/contract/__pycache__/test_contract.cpython-313-pytest-9.0.2.pyc", "pyc");
    await writeProjectFile(projectDir, "contract/checker_impls/__pycache__/custom_checker.cpython-313.pyc", "pyc");

    await runGenerate(projectDir, { force: true });

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
      generate: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
    };
    const program = createProgram({
      cwd: () => "E:/tmp/project",
      runCheck: handlers.check,
      runGenerate: handlers.generate,
      runLock: handlers.lock,
      runInit: handlers.init,
    });

    await program.parseAsync(["node", "stele", "check"]);
    await program.parseAsync(["node", "stele", "generate", "--force"]);
    await program.parseAsync(["node", "stele", "lock", "--reason", "approved"]);
    await program.parseAsync(["node", "stele", "init", "--language", "python"]);

    expect(handlers.check).toHaveBeenCalledWith("E:/tmp/project");
    expect(handlers.generate).toHaveBeenCalledWith("E:/tmp/project", { force: true });
    expect(handlers.lock).toHaveBeenCalledWith("E:/tmp/project", { reason: "approved" });
    expect(handlers.init).toHaveBeenCalledWith("E:/tmp/project", { language: "python" });
  });
});

async function createFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
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
