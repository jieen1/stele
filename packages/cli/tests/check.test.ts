import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallGraph } from "@stele/call-graph-core";
import {
  createViolation,
  createViolationReport,
  ruleId,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import { isCheckCommandError } from "../src/commands/check.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import {
  checkProject,
  createDiffNoChangesResult,
  mergeCheckReports,
  runCheck,
  type CheckCommandOptions,
} from "../src/commands/check.js";
import {
  collectDiffContractFiles,
  filterContractByFiles,
} from "../src/commands/check-diff.js";
import { runGenerate } from "../src/commands/generate.js";
import { runLock } from "../src/commands/lock.js";
import { createProgram } from "../src/index.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

describe("check --diff (incremental check)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("still verifies generated + protected files even when no contract files changed", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");
    await initializeGitRepo(projectDir);

    await git(projectDir, "add", ".");
    await git(projectDir, "commit", "-m", "clean baseline");

    // --diff HEAD finds no contract changes, but generated + protected integrity
    // checks still run against the full contract (1 invariant).
    const result = await checkProject(projectDir, { diff: "HEAD" });

    expect(result.summary.invariantCount).toBe(1);
    expect(result.report.ok).toBe(true);
    expect(result.report.summary.violation_count).toBe(0);
  });

  it("still runs full generated + protected verification when --diff is set", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");
    await initializeGitRepo(projectDir);

    await git(projectDir, "add", ".");
    await git(projectDir, "commit", "-m", "clean baseline");

    // Add a new invariant in a separate file and import it into main.stele.
    await writeProjectFile(
      projectDir,
      "contract/extra.stele",
      "(invariant EXTRA_RULE\n  (severity high)\n  (description \"Extra rule.\")\n  (assert (eq 1 1)))\n",
    );
    const mainContent = await readFile(join(projectDir, "contract", "main.stele"), "utf8");
    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      mainContent + '(import "./extra.stele")\n',
    );
    await git(projectDir, "add", "contract/extra.stele");
    await git(projectDir, "add", "contract/main.stele");
    await git(projectDir, "commit", "-m", "add extra contract");

    // Re-generate to include the new invariant.
    await runGenerate(projectDir, { force: true });
    await runLock(projectDir, { reason: "update after extra contract" });

    // Check with --diff against HEAD~1 (the clean baseline commit).
    // This should pass because generated files match the full contract.
    const result = await checkProject(projectDir, { diff: "HEAD~1" });

    expect(result.report.ok).toBe(true);
    // The invariant count reflects all invariants (full contract), not just changed ones.
    expect(result.summary.invariantCount).toBe(2);
  });

  it("defaults to HEAD when --diff is passed without a value", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");
    await initializeGitRepo(projectDir);

    await git(projectDir, "add", ".");
    await git(projectDir, "commit", "-m", "clean baseline");

    // --diff without a value defaults to HEAD.
    // No contract file changes since HEAD, so diff has 0 changed invariants for code-shape check,
    // but generated + protected checks still run against the full contract (1 invariant).
    const result = await checkProject(projectDir, { diff: true });

    expect(result.summary.invariantCount).toBe(1);
    expect(result.report.ok).toBe(true);
  });

  it("throws when git is not available (fail-closed)", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");

    // In a temp dir without a git repo, collectDiffContractFiles should throw.
    await expect(collectDiffContractFiles(projectDir, "HEAD")).rejects.toThrow(/Unable to find git repository root/i);
  });

  it("CLI wires --diff option correctly", async () => {
    const mockCheck = vi.fn(async () => { /* void */ });

    const program = createProgram({
      cwd: () => "E:/tmp/project",
      runCheck: mockCheck,
    });

    await program.parseAsync(["node", "stele", "check", "--diff", "main"]);

    expect(mockCheck).toHaveBeenCalledWith("E:/tmp/project", expect.objectContaining({
      diff: "main",
    }));

    // Also test --diff without a value (defaults to true).
    mockCheck.mockReset();
    await program.parseAsync(["node", "stele", "check", "--diff"]);

    expect(mockCheck).toHaveBeenCalledWith("E:/tmp/project", expect.objectContaining({
      diff: true,
    }));
  });
});

describe("collectDiffContractFiles", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("returns changed .stele files between two commits", async () => {
    const projectDir = await createFixtureProject();
    await initializeGitRepo(projectDir);

    await git(projectDir, "add", ".");
    await git(projectDir, "commit", "-m", "initial");

    // Create a new contract file and commit.
    await writeProjectFile(
      projectDir,
      "contract/extra.stele",
      "(invariant EXTRA_RULE\n  (severity high)\n  (description \"Extra rule.\")\n  (assert (eq 1 1)))\n",
    );
    await git(projectDir, "add", "contract/extra.stele");
    await git(projectDir, "commit", "-m", "add extra contract");

    const changedFiles = await collectDiffContractFiles(projectDir, "HEAD~1");

    expect(changedFiles).toContain("contract/extra.stele");
  });

  it("ignores non-.stele files in the diff", async () => {
    const projectDir = await createFixtureProject();
    await initializeGitRepo(projectDir);

    await git(projectDir, "add", ".");
    await git(projectDir, "commit", "-m", "initial");

    // Add a non-.stele file.
    await writeProjectFile(projectDir, "contract/notes.md", "# notes\n");
    await git(projectDir, "add", "contract/notes.md");
    await git(projectDir, "commit", "-m", "add notes");

    const changedFiles = await collectDiffContractFiles(projectDir, "HEAD~1");

    expect(changedFiles).toEqual([]);
  });
});

describe("filterContractByFiles", () => {
  it("filters invariants to only those in the given files", () => {
    const contract = createTestContract([
      { filePath: "contract/main.stele", id: "RULE_A" },
      { filePath: "contract/extra.stele", id: "RULE_B" },
      { filePath: "contract/main.stele", id: "RULE_C" },
    ]);

    const filtered = filterContractByFiles(contract, new Set(["contract/extra.stele"]));

    expect(filtered.invariants.map((inv) => inv.id)).toEqual(["RULE_B"]);
  });

  it("returns all invariants when all files are in the set", () => {
    const contract = createTestContract([
      { filePath: "contract/main.stele", id: "RULE_A" },
      { filePath: "contract/extra.stele", id: "RULE_B" },
    ]);

    const filtered = filterContractByFiles(
      contract,
      new Set(["contract/main.stele", "contract/extra.stele"]),
    );

    expect(filtered.invariants.map((inv) => inv.id)).toEqual(["RULE_A", "RULE_B"]);
  });

  it("returns no invariants when no files match", () => {
    const contract = createTestContract([
      { filePath: "contract/main.stele", id: "RULE_A" },
    ]);

    const filtered = filterContractByFiles(contract, new Set(["contract/other.stele"]));

    expect(filtered.invariants).toEqual([]);
  });
});

describe("createDiffNoChangesResult", () => {
  it("returns a successful check result with zero invariants", () => {
    const result = createDiffNoChangesResult([]);

    expect(result.summary.invariantCount).toBe(0);
    expect(result.summary.generatedFileCount).toBe(0);
    expect(result.summary.protectedFileCount).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.violations).toEqual([]);
  });
});

// ----------------------------------------------------------------
// P1-#2: check --changed end-to-end. An out-of-scope `--changed` file lets the
// planner skip the (clean) code-shape stage, but the always-force-run effect
// stage still evaluates and its in-scope violation MUST still fail the check.
//
// This is exactly the seam the two CRITICAL false-greens slipped through: a
// would-be violation in a force-run call-graph stage must never be hidden by an
// over-broad incremental skip. Teeth: adding `effect` to the planner's skippable
// set (SKIPPABLE_STAGE_MECHANISMS in check-incremental.ts) makes this check pass
// — so this test fails — proving the force-run guarantee is load-bearing.
// ----------------------------------------------------------------

describe("check --changed — an out-of-scope change skips code-shape but a force-run effect violation still fails", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  // @tcb-negative @stele/cli
  it("rejects (effect violation reported, exit 3) even though code-shape is skipped", async () => {
    const projectDir = await createTempDir();
    // Copy the self-contained effect-violation fixture (a UI component in
    // src/components/** that performs db.read — forbidden by NO_IO_IN_UI).
    const fixtureDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/effect/03-forbid-policy-violation",
    );
    await cp(join(fixtureDir, "contract"), join(projectDir, "contract"), { recursive: true });
    await cp(join(fixtureDir, "src"), join(projectDir, "src"), { recursive: true });
    await cp(join(fixtureDir, "tsconfig.json"), join(projectDir, "tsconfig.json"));

    // A CLEAN class-shape (Widget has the required `render` method) so code-shape
    // binds a file and is genuinely skippable when nothing in its scope changed.
    await writeProjectFile(
      projectDir,
      "src/widget.ts",
      ["export class Widget {", "  render(): string {", '    return "";', "  }", "}", ""].join("\n"),
    );
    // The out-of-scope changed file: in neither the class-shape target nor the
    // effect-policy target-scope (src/components/**).
    await writeProjectFile(projectDir, "src/unrelated.ts", "export const z = 1;\n");
    const mainStele = await readFile(join(projectDir, "contract", "main.stele"), "utf8");
    await writeProjectFile(
      projectDir,
      "contract/main.stele",
      mainStele +
        ["", "(class-shape cs-widget", "  (lang typescript)", '  (target "src/widget.ts::Widget")', '  (must-have-method "render"))', ""].join("\n"),
    );
    await writeProjectFile(
      projectDir,
      STELE_CONFIG_FILE,
      `${JSON.stringify({ ...DEFAULT_CONFIG, targetLanguage: "typescript", testFramework: "vitest" }, null, 2)}\n`,
    );

    await runGenerate(projectDir, { force: false });
    await runLock(projectDir, { reason: "effect fixture baseline" });

    // A synthetic call graph that attributes the effect-policy's scope to
    // component files. With it, the planner CAN reason about effect's coverage —
    // which makes the force-run guarantee (effect is never skippable) the only
    // thing keeping the violation visible under an out-of-scope change. If the
    // planner ever added effect to its skippable set, this graph would let it
    // skip effect (its files are disjoint from src/unrelated.ts) and hide the
    // violation.
    const callGraph: CallGraph = {
      schemaVersion: "1",
      language: "typescript",
      generatedAt: "2026-01-01T00:00:00Z",
      projectRoot: projectDir,
      nodes: [
        { id: "src/components/UserCard.ts::UserCard(1)", kind: "function", filePath: "src/components/UserCard.ts", span: { line: 1, column: 1 }, signature: "UserCard", isExported: true, isAsync: false },
        { id: "src/db.ts::findUser(1)", kind: "function", filePath: "src/db.ts", span: { line: 1, column: 1 }, signature: "findUser", isExported: true, isAsync: false },
      ],
      edges: [
        { fromId: "src/components/UserCard.ts::UserCard(1)", toId: "src/db.ts::findUser(1)", callSite: { line: 1, column: 1 }, isConditional: false, isLoop: false, isAsync: false },
      ],
      unresolvedCalls: [],
      ambiguousCalls: [],
      methodResolutionHash: "0".repeat(64),
      fileHashes: {},
    };

    const notes: string[] = [];
    let thrown: unknown;
    try {
      await checkProject(
        projectDir,
        { changed: ["src/unrelated.ts"] },
        { incremental: { buildCallGraph: async () => callGraph }, emit: (c) => notes.push(c) },
      );
    } catch (error) {
      thrown = error;
    }

    // The check must REJECT: the effect violation is fatal even under --changed.
    expect(isCheckCommandError(thrown)).toBe(true);
    if (!isCheckCommandError(thrown)) throw thrown;
    expect(thrown.exitCode).toBe(3);
    expect(thrown.report.ok).toBe(false);
    expect(thrown.report.violations.some((v) => v.rule_kind === "effect_violation")).toBe(true);

    // And the banner must confirm code-shape WAS skipped (otherwise the test
    // would be trivially green — it would pass even if nothing was skipped).
    const banner = notes.join("");
    expect(banner).toMatch(/stages skipped \(NOT run\): .*code-shape/);
  });
});

// ----------------------------------------------------------------
// P2-#5: mergeCheckReports verdict semantics. The merged `ok` is driven by the
// ACTIVE BLOCKING violation count (severity error; warning/info do not block;
// status suppressed/out_of_scope do not block). Teeth: widening the
// blocking-severity set (isBlockingViolation in check.ts) — e.g. treating
// "warning" as blocking — flips the warning-only case from ok to not-ok, and
// narrowing it (treating "error" as non-blocking) flips the error case from
// not-ok to ok. Either mutation breaks one of these assertions.
// ----------------------------------------------------------------

describe("mergeCheckReports — verdict by active blocking severity", () => {
  function violation(
    id: string,
    severity: Violation["severity"],
    status?: Violation["status"],
  ): Violation {
    return createViolation({
      rule_id: ruleId(id),
      rule_kind: "rule_violation",
      severity,
      source: { tool: "stele", command: "check", kind: "rule" },
      location: { path: "src/x.ts" },
      cause: { summary: `v ${id}` },
      scope_paths: ["src/x.ts"],
      ...(status === undefined ? {} : { status }),
    });
  }

  function reportWith(violations: Violation[]): ViolationReport {
    return createViolationReport({
      tool: "stele",
      command: "check",
      ok: violations.length === 0,
      summary: { invariant_count: 0, violation_count: violations.length },
      violations,
    });
  }

  it("warning/info-only violations do NOT block (ok stays true)", () => {
    const merged = mergeCheckReports([
      reportWith([violation("warn-rule", "warning"), violation("info-rule", "info")]),
    ]);
    expect(merged.ok).toBe(true);
    expect(merged.summary.active_violation_count).toBe(2);
  });

  it("a single ACTIVE error blocks (ok becomes false)", () => {
    const merged = mergeCheckReports([
      reportWith([violation("warn-rule", "warning"), violation("err-rule", "error")]),
    ]);
    expect(merged.ok).toBe(false);
  });

  it("a SUPPRESSED error does NOT block (ok stays true)", () => {
    const merged = mergeCheckReports([
      reportWith([violation("suppressed-err", "error", "suppressed")]),
    ]);
    expect(merged.ok).toBe(true);
    expect(merged.summary.suppressed_violation_count).toBe(1);
  });
});

// ---- Helpers ----

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
    ].join("\n") + "\n",
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
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-check-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function runGenerateAndLock(projectDir: string, reason = "approved baseline"): Promise<void> {
  await runGenerate(projectDir, { force: false });
  await runLock(projectDir, { reason });
}

async function initializeGitRepo(projectDir: string): Promise<void> {
  await git(projectDir, "init", "--initial-branch=main");
  await git(projectDir, "config", "user.name", "Stele Test");
  await git(projectDir, "config", "user.email", "stele@example.com");
}

async function git(projectDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: projectDir });
  return stdout.trim();
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

function createTestContract(invariants: Array<{ filePath: string; id: string }>): any {
  const files = new Map<string, any>();

  for (const inv of invariants) {
    if (!files.has(inv.filePath)) {
      files.set(inv.filePath, {
        path: inv.filePath,
        invariants: [],
        groups: [],
        codeShapes: [],
      });
    }
    files.get(inv.filePath).invariants.push({
      kind: "invariant",
      filePath: inv.filePath,
      id: inv.id,
      severity: "high",
      description: `Rule ${inv.id}`,
      assertExpression: null,
      dependsOn: [],
    });
  }

  return {
    rootPath: "/project",
    files: [...files.values()],
    metadata: [],
    imports: [],
    operators: [],
    checkers: [],
    scenarios: [],
    groups: [],
    invariants: invariants.map((inv) => ({
      kind: "invariant",
      filePath: inv.filePath,
      id: inv.id,
      severity: "high",
      description: `Rule ${inv.id}`,
      assertExpression: null,
      dependsOn: [],
    })),
    codeShapes: [],
  };
}
