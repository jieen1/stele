import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createViolation, createViolationReport } from "@stele/core";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { runBaselineInit } from "../src/commands/baseline.js";
import { runCheck } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runLock } from "../src/commands/lock.js";
import { createProgram } from "../src/index.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

describe("baseline and diff checks", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("baseline-init creates a baseline file but generated drift still fails check", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");

    await runBaselineInit(projectDir, { reason: "initial legacy adoption" });
    await expect(pathExists(join(projectDir, "contract", ".baseline.json"))).resolves.toBe(true);

    await writeProjectFile(projectDir, "tests/contract/test_contract.py", "# tampered\n");
    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check --diff-from does not hide protected drift outside the current git scope", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");
    await initializeGitRepo(projectDir);

    await git(projectDir, "add", ".");
    await git(projectDir, "commit", "-m", "clean baseline");

    await writeProjectFile(projectDir, "contract/checker_impls/custom_checker.py", "def custom_checker(context):\n    return False\n");
    await git(projectDir, "add", "contract/checker_impls/custom_checker.py");
    await git(projectDir, "commit", "-m", "legacy protected drift");

    await writeProjectFile(projectDir, "notes.md", "# branch note\n");
    await git(projectDir, "add", "notes.md");
    await git(projectDir, "commit", "-m", "unrelated note");

    await expect(runCheck(projectDir, { diffFrom: "HEAD~1" })).rejects.toThrow(/manifest|protected/i);
  });

  it("baseline remains manifest-protected even when custom protected config omits it", async () => {
    const projectDir = await createFixtureProject({
      protected: DEFAULT_CONFIG.protected.filter((pattern) => pattern !== "contract/.baseline.json"),
    });

    await runGenerate(projectDir, { force: false });
    await runLock(projectDir, { reason: "initial contract baseline" });
    await runBaselineInit(projectDir, { reason: "initial legacy adoption" });

    const manifest = await readJson(join(projectDir, "contract", ".manifest.json"));
    expect(Object.keys(manifest.protected_files)).toContain("contract/.baseline.json");

    const baseline = await readJson(join(projectDir, "contract", ".baseline.json"));
    baseline.reason = "manual edit";
    await writeProjectFile(projectDir, "contract/.baseline.json", `${JSON.stringify(baseline, null, 2)}\n`);

    await expect(runCheck(projectDir)).rejects.toThrow(/manifest|protected/i);
  });

  it("CLI check --json and --report-file include suppressed baseline metadata for synthetic rule violations", async () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    const originalExitCode = process.exitCode;
    const projectDir = await createFixtureProject();
    const syntheticViolation = createViolation({
      rule_id: "ledger.balance_mismatch",
      rule_kind: "rule_violation",
      severity: "error",
      source: {
        tool: "ledger-checker",
        command: "check",
        kind: "rule",
      },
      location: {
        path: "src/payments.ts",
      },
      cause: {
        summary: "Payments remain unbalanced after settlement.",
      },
      scope_paths: ["contract/main.stele", "src/payments.ts"],
      status: "suppressed",
      suppressed_by: "baseline",
    });
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: true,
      summary: {
        message: "OK 1 invariant checked; 3 generated files and 6 protected files verified. (1 baseline violation suppressed)",
        invariant_count: 1,
        generated_file_count: 3,
        protected_file_count: 6,
        violation_count: 1,
        active_violation_count: 0,
        suppressed_violation_count: 1,
        out_of_scope_violation_count: 0,
      },
      violations: [syntheticViolation],
    });

    const program = createProgram({
      cwd: () => projectDir,
      runCheck: vi.fn(async () => ({
        summary: {
          invariantCount: 1,
          generatedFileCount: 3,
          protectedFileCount: 6,
        },
        report,
      })),
    });

    process.exitCode = 0;
    await program.parseAsync(["node", "stele", "check", "--json", "--report-file", ".stele/reports/last.json"]);

    const stdoutReport = JSON.parse(stdout.read()) as {
      ok: boolean;
      summary: {
        violation_count: number;
        active_violation_count: number;
        suppressed_violation_count: number;
        out_of_scope_violation_count: number;
      };
      violations: Array<{
        rule_id: string;
        status: string;
        suppressed_by?: string;
      }>;
    };
    const fileReport = await readJson(join(projectDir, ".stele", "reports", "last.json"));

    expect(process.exitCode).toBe(0);
    expect(stderr.read()).toBe("");
    expect(stdoutReport).toMatchObject({
      ok: true,
      summary: {
        violation_count: 1,
        active_violation_count: 0,
        suppressed_violation_count: 1,
        out_of_scope_violation_count: 0,
      },
      violations: [
        {
          rule_id: "ledger.balance_mismatch",
          status: "suppressed",
          suppressed_by: "baseline",
        },
      ],
    });
    expect(fileReport).toMatchObject(stdoutReport);
    process.exitCode = originalExitCode;
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
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-baseline-"));
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

async function runGenerateAndLock(projectDir: string, reason = "approved baseline"): Promise<void> {
  await runGenerate(projectDir, { force: false });
  await runLock(projectDir, { reason });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
