import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLock, lockProject } from "../src/commands/lock.js";
import { unlockProject } from "../src/commands/unlock.js";
import { runDev } from "../src/commands/dev.js";
import { runDoc } from "../src/commands/doc.js";
import { runMaintenanceSummary } from "../src/commands/maintenance.js";
import { runWhy } from "../src/commands/why.js";
import { runExplain } from "../src/commands/explain.js";
import { runGenerate } from "../src/commands/generate.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

const tempDirs: string[] = [];

describe("commands coverage", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  describe("lock", () => {
    it("lockProject creates a manifest when generated files are up to date", async () => {
      const projectDir = await createFixtureProject();
      await runGenerate(projectDir, { force: true });

      const summary = await lockProject(projectDir, {});

      expect(summary.invariantCount).toBe(2);
      expect(summary.protectedFileCount).toBeGreaterThan(0);
      expect(summary.manifestPath).toBe(DEFAULT_CONFIG.manifestPath);

      const manifest = await readFile(join(projectDir, "contract", ".manifest.json"), "utf8");
      const parsed = JSON.parse(manifest);
      expect(parsed.protected_files).toBeDefined();
    });

    it("lockProject throws when generated files are out of date", async () => {
      const projectDir = await createTempDir();
      await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
      await writeProjectFile(
        projectDir,
        "contract/main.stele",
        "(invariant OUT_OF_DATE\n  (severity high)\n  (description \"Test.\")\n  (assert (eq 1 1)))\n",
      );

      await expect(lockProject(projectDir, {})).rejects.toThrow(/generated files are out of date/i);
    });

    it("runLock delegates to lockProject without error", async () => {
      const projectDir = await createFixtureProject();
      await runGenerate(projectDir, { force: true });

      await expect(runLock(projectDir, { reason: "test" })).resolves.toBeUndefined();
    });
  });

  describe("unlock", () => {
    it("unlock removes both manifest and baseline when they exist", async () => {
      const projectDir = await createFixtureProject();
      await writeProjectFile(projectDir, "contract/.manifest.json", '{"protected_files":{}}\n');
      await writeProjectFile(projectDir, "contract/.baseline.json", '[]\n');

      const result = await unlockProject(projectDir, { reason: "test unlock", confirm: true });

      expect(result.manifestPath).toBeDefined();
      expect(result.baselinePath).toBeDefined();

      const log = await readFile(join(projectDir, "contract", ".unlock-log.jsonl"), "utf8");
      const entry = JSON.parse(log.trim());
      expect(entry.reason).toBe("test unlock");
    });

    it("unlock handles missing manifest gracefully", async () => {
      const projectDir = await createFixtureProject();
      await writeProjectFile(projectDir, "contract/.baseline.json", '[]\n');

      const result = await unlockProject(projectDir, { reason: "partial", confirm: true });

      expect(result).toBeDefined();
      const log = await readFile(join(projectDir, "contract", ".unlock-log.jsonl"), "utf8");
      const entry = JSON.parse(log.trim());
      expect(entry.removed.length).toBeGreaterThan(0);
    });

    it("unlock handles missing baseline gracefully", async () => {
      const projectDir = await createFixtureProject();
      await writeProjectFile(projectDir, "contract/.manifest.json", '{"protected_files":{}}\n');

      const result = await unlockProject(projectDir, { reason: "partial", confirm: true });

      expect(result).toBeDefined();
    });

    it("unlock appends to existing unlock log", async () => {
      const projectDir = await createFixtureProject();
      await writeProjectFile(projectDir, "contract/.manifest.json", '{"protected_files":{}}\n');
      await writeProjectFile(
        projectDir,
        "contract/.unlock-log.jsonl",
        '{"reason":"first","removed":[],"timestamp":"2024-01-01T00:00:00Z"}\n',
      );

      await unlockProject(projectDir, { reason: "second", confirm: true });

      const log = await readFile(join(projectDir, "contract", ".unlock-log.jsonl"), "utf8");
      const lines = log.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).reason).toBe("first");
      expect(JSON.parse(lines[1]).reason).toBe("second");
    });

    it("unlock prints warning and throws without --confirm", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await expect(unlockProject(projectDir, { reason: "no confirm", confirm: false })).rejects.toThrow(/confirm/i);
      expect(stdout.read()).toContain("Add --confirm to proceed");
    });
  });

  describe("dev", () => {
    it("dev --once runs generate and check", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runDev(projectDir, { once: true });

      const output = stdout.read();
      expect(output).toContain("[stele] Running once (no watch).");
      expect(output).toContain("[stele] Generating contract tests...");
      expect(output).toContain("[stele] Running contract checks...");
      expect(output).toContain("[stele] Watching...");
    });

    it("dev fails when contract directory does not exist", async () => {
      const projectDir = await createTempDir();
      const stderr = captureStderr();
      const originalExitCode = process.exitCode;

      await runDev(projectDir, {});

      expect(stderr.read()).toContain('No "contract" directory found');
      expect(process.exitCode).toBe(1);
      process.exitCode = originalExitCode;
    });

    it("dev --once handles missing Python gracefully", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFile: (...args: any[]) => {
          const cb = args[args.length - 1];
          if (typeof cb === "function") {
            cb(new Error("command not found"), "", "");
          }
        },
        execFileSync: (vi.importActual("node:child_process") as any).execFileSync,
        exec: (vi.importActual("node:child_process") as any).exec,
        spawn: (vi.importActual("node:child_process") as any).spawn,
      }));

      const { runDev: mockedRunDev } = await import("../src/commands/dev.js");

      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await mockedRunDev(projectDir, { once: true });

      const output = stdout.read();
      expect(output).toContain("[stele] Generating contract tests...");
      expect(output).toContain("[stele] Running contract checks...");
      expect(output).toContain("[stele] Watching...");
    });
  });

  describe("doc", () => {
    it("doc generates markdown with invariant details", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runDoc(projectDir, { format: "markdown", output: join(projectDir, "docs", "contract") });

      expect(stdout.read()).toContain("Contract documentation written to contract.md");
      const content = await readFile(join(projectDir, "docs", "contract", "contract.md"), "utf8");
      expect(content).toContain("# Contract Documentation");
      expect(content).toContain("## TEST_INVARIANT");
      expect(content).toContain("| Severity | high |");
      expect(content).toContain("| Description | Test invariant for coverage. |");
    });

    it("doc generates HTML with invariant table", async () => {
      const projectDir = await createFixtureProject();

      await runDoc(projectDir, { format: "html", output: join(projectDir, "docs", "contract") });

      const content = await readFile(join(projectDir, "docs", "contract", "index.html"), "utf8");
      expect(content).toContain("<!DOCTYPE html>");
      expect(content).toContain("<h1>Contract Documentation</h1>");
      expect(content).toContain("TEST_INVARIANT");
      expect(content).toContain("high");
    });

    it("doc writes to default directory when output is not specified", async () => {
      const projectDir = await createFixtureProject();

      await runDoc(projectDir, { format: "markdown" });

      const content = await readFile(join(projectDir, "docs", "contract", "contract.md"), "utf8");
      expect(content).toContain("# Contract Documentation");
    });

    it("doc includes category and rationale when present", async () => {
      const projectDir = await createTempDir();
      await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
      await writeProjectFile(
        projectDir,
        "contract/main.stele",
        [
          "(invariant RICH_INVARIANT",
          "  (severity critical)",
          '  (description "Rich invariant with metadata.")',
          "  (category data-integrity)",
          '  (rationale "Ensures data integrity.")',
          "  (assert (eq 1 1)))",
        ].join("\n") + "\n",
      );

      await runDoc(projectDir, { format: "markdown", output: join(projectDir, "docs", "contract") });

      const content = await readFile(join(projectDir, "docs", "contract", "contract.md"), "utf8");
      expect(content).toContain("| Category | data-integrity |");
      expect(content).toContain("| Rationale | Ensures data integrity. |");
    });
  });

  describe("maintenance", () => {
    it("maintenance-summary outputs to file when output path is given", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runMaintenanceSummary(projectDir, {
        from: "HEAD~1",
        output: ".stele/maintenance/summary.md",
      });

      expect(stdout.read()).toContain("OK wrote Stele maintenance summary");
      const summary = await readFile(join(projectDir, ".stele", "maintenance", "summary.md"), "utf8");
      expect(summary).toContain("# Stele Maintenance Summary");
      expect(summary).toContain("Contract inventory");
      expect(summary).toContain("Candidate questions for newly learned behavior");
      expect(summary).toContain("stele propose invariant --apply");
      expect(summary).toContain("Modifications and deletions require explicit user review");
    });

    it("maintenance-summary writes to stdout when no output path is given", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runMaintenanceSummary(projectDir, {});

      const output = stdout.read();
      expect(output).toContain("# Stele Maintenance Summary");
      expect(output).toContain("Contract inventory");
    });

    it("maintenance-summary includes invariant count", async () => {
      const projectDir = await createFixtureProject();

      await runMaintenanceSummary(projectDir, { output: ".stele/maintenance/summary2.md" });

      const summary = await readFile(join(projectDir, ".stele", "maintenance", "summary2.md"), "utf8");
      expect(summary).toContain("Invariants: 2");
    });

    it("maintenance-summary handles missing git gracefully", async () => {
      const projectDir = await createFixtureProject();

      await runMaintenanceSummary(projectDir, {
        output: ".stele/maintenance/summary3.md",
      });

      const summary = await readFile(join(projectDir, ".stele", "maintenance", "summary3.md"), "utf8");
      expect(summary).toContain("Git diff scope unavailable");
    });
  });

  describe("why", () => {
    it("why prints human-readable rule explanation", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runWhy(projectDir, "TEST_INVARIANT", {});

      const output = stdout.read();
      expect(output).toContain("Rule: TEST_INVARIANT");
      expect(output).toContain("Severity: high");
      expect(output).toContain("Description: Test invariant for coverage.");
      expect(output).toContain("First repair ordinary source code, fixtures, or scenario setup if they drifted.");
      expect(output).toContain("Only ask to modify this contract when the intended behavior changed.");
    });

    it("why outputs JSON when --json flag is set", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runWhy(projectDir, "TEST_INVARIANT", { json: true });

      const parsed = JSON.parse(stdout.read());
      expect(parsed.schema_version).toBe("1");
      expect(parsed.tool).toBe("@stele/cli");
      expect(parsed.command).toBe("why");
      expect(parsed.rule_id).toBe("TEST_INVARIANT");
      expect(parsed.severity).toBe("high");
      expect(parsed.last_check_status).toBe("no-report");
      expect(parsed.guidance).toBeDefined();
    });

    it("why throws for unknown rule id", async () => {
      const projectDir = await createFixtureProject();

      await expect(runWhy(projectDir, "NONEXISTENT", {})).rejects.toThrow(/NONEXISTENT/);
    });
  });

  describe("explain", () => {
    it("explain prints invariant details including source", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runExplain(projectDir, "TEST_INVARIANT");

      const output = stdout.read();
      expect(output).toContain("ID: TEST_INVARIANT");
      expect(output).toContain("Generated Test Path: tests/contract/test_contract.py");
      expect(output).toContain("Source:");
      expect(output).toContain("(invariant TEST_INVARIANT");
    });

    it("explain outputs JSON when --json flag is set", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runExplain(projectDir, "TEST_INVARIANT", { json: true });

      const parsed = JSON.parse(stdout.read());
      expect(parsed.rule.id).toBe("TEST_INVARIANT");
      expect(parsed.source).toContain("(invariant TEST_INVARIANT");
    });

    it("explain throws for unknown invariant id", async () => {
      const projectDir = await createFixtureProject();

      await expect(runExplain(projectDir, "UNKNOWN_INVARIANT")).rejects.toThrow(/UNKNOWN_INVARIANT/);
    });

    it("explain shows group invariant with generated group path", async () => {
      const projectDir = await createFixtureProject();
      const stdout = captureStdout();

      await runExplain(projectDir, "GROUPED_INVARIANT");

      const output = stdout.read();
      expect(output).toContain("ID: GROUPED_INVARIANT");
      expect(output).toContain("test_my_group.py");
      expect(output).toContain("Checker ID: test_checker");
    });
  });
});

// --- helpers ---

async function createFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(checker test_checker",
      '  (description "A test checker."))',
      "",
      "(invariant TEST_INVARIANT",
      "  (severity high)",
      '  (description "Test invariant for coverage.")',
      "  (assert (eq 1 1)))",
      "",
      "(group my-group",
      '  (description "A test group.")',
      "  (invariant GROUPED_INVARIANT",
      "    (severity medium)",
      '    (description "Grouped invariant.")',
      "    (uses-checker test_checker)))",
    ].join("\n") + "\n",
  );
  await writeProjectFile(
    projectDir,
    "contract/checker_impls/test_checker.py",
    "def test_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    [
      "import pytest",
      "",
      "@pytest.fixture",
      "def stele_context():",
      "    return {",
      '        "_stele_checkers": {',
      '            "test_checker": lambda ctx, **kw: {"passed": True, "message": None},',
      "        },",
      "    }",
    ].join("\n") + "\n",
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
