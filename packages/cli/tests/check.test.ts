import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import {
  checkProject,
  createDiffNoChangesResult,
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
