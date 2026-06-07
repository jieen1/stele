import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Round 4 F-D-02: skip pytest-dependent tests when pytest is absent.
const _PYTEST_AVAILABLE_FD02 = (() => {
  try {
    execFileSync("python3", ["-c", "import pytest"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const itIfPytest = _PYTEST_AVAILABLE_FD02 ? it : it.skip;
import { runDev } from "../src/commands/dev.js";
import { runDoc } from "../src/commands/doc.js";
import { unlockProject } from "../src/commands/unlock.js";
import { runList } from "../src/commands/list.js";
import { checkProject } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { lockProject } from "../src/commands/lock.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

const tempDirs: string[] = [];

describe("new commands", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  describe("dev --once", () => {
    itIfPytest("dev --once runs generate and check without watching", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();
      const stderr = captureStderr();

      await runDev(projectDir, { once: true });

      const output = stdout.read();
      expect(output).toContain("[stele] Running once (no watch).");
      expect(output).toContain("[stele] Generating contract tests...");
      expect(output).toContain("[stele] Running contract checks...");
      expect(output).toContain("[stele] Watching...");
      expect(stderr.read()).not.toContain("No");
    });

    it("dev fails when no contract directory exists", async () => {
      const projectDir = await createTempDir();
      const stderr = captureStderr();
      const originalExitCode = process.exitCode;

      await runDev(projectDir, { once: true });

      expect(stderr.read()).toContain('No "contract" directory found');
      expect(process.exitCode).toBe(1);
      process.exitCode = originalExitCode;
    });
  });

  describe("doc", () => {
    it("doc generates markdown documentation with all invariants", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runDoc(projectDir, { format: "markdown", output: join(projectDir, "docs", "contract") });

      expect(stdout.read()).toContain("Contract documentation written to contract.md");
      const content = await readFile(join(projectDir, "docs", "contract", "contract.md"), "utf8");
      expect(content).toContain("# Contract Documentation");
      expect(content).toContain("## ROOT_PAYMENT_BALANCE");
      expect(content).toContain("| Severity | critical |");
      expect(content).toContain("| Description | Payments remain balanced before settlement. |");
    });

    it("doc generates HTML documentation", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runDoc(projectDir, { format: "html", output: join(projectDir, "docs", "contract") });

      expect(stdout.read()).toContain("Contract documentation written to index.html");
      const content = await readFile(join(projectDir, "docs", "contract", "index.html"), "utf8");
      expect(content).toContain("<!DOCTYPE html>");
      expect(content).toContain("<h1>Contract Documentation</h1>");
      expect(content).toContain("ROOT_PAYMENT_BALANCE");
      expect(content).toContain("critical");
    });

    it("doc writes to custom output directory", async () => {
      const projectDir = await createFixtureProject();
      await runDoc(projectDir, { format: "markdown", output: join(projectDir, "custom", "docs") });

      const content = await readFile(join(projectDir, "custom", "docs", "contract.md"), "utf8");
      expect(content).toContain("# Contract Documentation");
    });
  });

  describe("unlock", () => {
    it("unlock removes manifest and baseline files with audit log", async () => {
      const projectDir = await createFixtureProject();
      await writeProjectFile(projectDir, "contract/.manifest.json", '{"protected_files":{}}\n');
      await writeProjectFile(projectDir, "contract/baseline.json", '[]\n');

      const result = await unlockProject(projectDir, { reason: "test unlock", confirm: true });

      expect(result).toBeDefined();
      expect(result.manifestPath).toBeDefined();
      expect(result.baselinePath).toBeDefined();
    });

    // @tcb-negative unlock
    it("unlock without confirm throws error", async () => {
      const projectDir = await createFixtureProject();

      await expect(unlockProject(projectDir, { reason: "test", confirm: false })).rejects.toThrow(/confirm/i);
    });
  });

  describe("list --format json", () => {
    it("list --format json outputs machine-readable array", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runList(projectDir, { format: "json" });

      const json = JSON.parse(stdout.read());
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBeGreaterThan(0);
      expect(json[0]).toHaveProperty("id");
      expect(json[0]).toHaveProperty("severity");
    });
  });

  describe("check --lenient", () => {
    it("check --lenient skips code-shape checks", async () => {
      const projectDir = await createFixtureProject();
      await runGenerate(projectDir, { force: true });
      await lockProject(projectDir, { reason: "test" });

      const result = await checkProject(projectDir, { lenient: true });

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.invariantCount).toBeGreaterThan(0);
    });
  });
});

async function createFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(checker approved_checker",
      '  (description "Checker for settlement approvals."))',
      "",
      "(invariant PAYMENT_BASELINE",
      "  (severity high)",
      '  (description "Baseline rule used as a dependency target.")',
      "  (assert (eq 1 1)))",
      "",
      "(invariant ROOT_PAYMENT_BALANCE",
      "  (severity critical)",
      '  (description "Payments remain balanced before settlement.")',
      "  (category data-integrity)",
      '  (tags payment :priority "batch window")',
      '  (rationale "Preserve the accounting invariant before settlement.")',
      "  (depends-on PAYMENT_BASELINE)",
      "  (assert (eq 1 1)))",
      "",
      "(group batch-reconciliation",
      '  (description "Group for settlement checks.")',
      "  (invariant GROUP_CHECKED_SETTLEMENT",
      "    (severity warning)",
      '    (description "Settlement batches require an approved checker.")',
      "    (category (domain ledger))",
      "    (tags payment (scope nightly) 7)",
      "    (uses-checker approved_checker)))",
    ].join("\n") + "\n",
  );
  await writeProjectFile(
    projectDir,
    "contract/checker_impls/approved_checker.py",
    "def approved_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    [
      "import pytest",
      "",
      "@pytest.fixture",
      "def stele_context():",
      '    return {"_stele_checkers": {"approved_checker": lambda ctx: {"passed": True, "message": None}}}',
      "",
      "@pytest.fixture",
      "def stele_sandbox():",
      "    return None",
      "",
    ].join("\n"),
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
