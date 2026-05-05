import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createViolationReport, formatViolationReportJson, loadContract } from "@stele/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBaselineInit } from "../src/commands/baseline.js";
import { checkProject, formatCheckReportHuman, runCheck } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runLock } from "../src/commands/lock.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { runCli } from "../src/index.js";
import { evaluateCodeShapes } from "../src/code-shape/evaluate.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

describe("code-shape evaluation", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("evaluates Python code-shapes, respects allow-target, and formats precise fixes and locations", async () => {
    const projectDir = await createCodeShapeProject({
      contractSource: [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/**/*.py")',
        '  (deny-import "app.infrastructure")',
        '  (allow-target "src/api/allowed.py"))',
        "(file-policy settings_layout",
        "  (lang python)",
        '  (target "src/settings.py")',
        '  (must-contain "from __future__ import annotations")',
        '  (must-end-with "\\n"))',
      ].join("\n"),
      files: {
        "src/api/handlers.py": 'import app.infrastructure.db\n\n\ndef handle_request() -> None:\n    return None\n',
        "src/api/allowed.py": 'import app.infrastructure.db\n\n\ndef allowed_handler() -> None:\n    return None\n',
        "src/settings.py": "DEBUG = True",
      },
    });

    const contract = await loadContract(join(projectDir, "contract", "main.stele"));
    const violations = await evaluateCodeShapes(projectDir, contract, "check");
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: false,
      summary: {
        violation_count: violations.length,
      },
      violations,
    });
    const humanReport = formatCheckReportHuman(report);
    const jsonReport = formatViolationReportJson(report);

    expect(violations.filter((violation) => violation.rule_id === "api_boundary")).toHaveLength(1);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "api_boundary",
          location: expect.objectContaining({
            path: "src/api/handlers.py",
            line: 1,
          }),
          fix: expect.objectContaining({
            summary: expect.stringContaining("Remove the forbidden import"),
          }),
        }),
        expect.objectContaining({
          rule_id: "settings_layout",
          location: expect.objectContaining({
            path: "src/settings.py",
            line: 1,
          }),
          cause: expect.objectContaining({
            summary: expect.stringContaining("must contain"),
          }),
        }),
        expect.objectContaining({
          rule_id: "settings_layout",
          location: expect.objectContaining({
            path: "src/settings.py",
          }),
          cause: expect.objectContaining({
            summary: expect.stringContaining("must end with"),
          }),
        }),
      ]),
    );
    expect(humanReport).toContain("[error] api_boundary");
    expect(humanReport).toContain("src/api/handlers.py:1");
    expect(humanReport).toContain("fix:");
    expect(jsonReport).toContain('"rule_id": "api_boundary"');
    expect(jsonReport).toContain('"path": "src/api/handlers.py"');
  });

  it("baseline-init suppresses existing code-shape violations but generated drift still fails check", async () => {
    const projectDir = await createCodeShapeProject({
      contractSource: [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/**/*.py")',
        '  (deny-import "app.infrastructure"))',
      ].join("\n"),
      files: {
        "src/api/handlers.py": 'import app.infrastructure.db\n',
      },
    });

    await runGenerateAndLock(projectDir, "initial code-shape baseline");
    await runBaselineInit(projectDir, { reason: "approve legacy code-shape debt" });

    const result = await checkProject(projectDir);

    expect(result.report.ok).toBe(true);
    expect(result.report.summary.suppressed_violation_count).toBe(1);
    expect(result.report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "api_boundary",
          status: "suppressed",
          suppressed_by: "baseline",
        }),
      ]),
    );

    await writeProjectFile(projectDir, "tests/contract/test_contract.py", "# tampered\n");
    await expect(runCheck(projectDir)).rejects.toThrow(/generated/i);
  });

  it("check --diff-from marks code-shape violations outside the diff scope as out_of_scope", async () => {
    const projectDir = await createCodeShapeProject({
      contractSource: [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/**/*.py")',
        '  (deny-import "app.infrastructure"))',
      ].join("\n"),
      files: {
        "src/api/handlers.py": 'import app.infrastructure.db\n',
      },
    });

    await runGenerateAndLock(projectDir, "initial diff baseline");
    await initializeGitRepo(projectDir);
    await git(projectDir, "add", ".");
    await git(projectDir, "commit", "-m", "baseline");
    await writeProjectFile(projectDir, "notes.md", "# unrelated note\n");

    const result = await checkProject(projectDir, { diffFrom: "HEAD" });

    expect(result.report.ok).toBe(true);
    expect(result.report.summary.out_of_scope_violation_count).toBe(1);
    expect(result.report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "api_boundary",
          status: "out_of_scope",
        }),
      ]),
    );
  });

  it("CLI check prints code-shape violations in human and JSON output", async () => {
    const projectDir = await createCodeShapeProject({
      contractSource: [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/api/**/*.py")',
        '  (deny-import "app.infrastructure"))',
        "(file-policy settings_layout",
        "  (lang python)",
        '  (target "src/settings.py")',
        '  (must-contain "from __future__ import annotations"))',
      ].join("\n"),
      files: {
        "src/api/handlers.py": 'import app.infrastructure.db\n',
        "src/settings.py": "DEBUG = True\n",
      },
    });
    const humanStderr = captureStderr();
    const originalExitCode = process.exitCode;

    await runGenerateAndLock(projectDir, "initial cli baseline");

    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "check"]);

    expect(process.exitCode).toBe(3);
    expect(humanStderr.read()).toContain("[error] api_boundary");
    expect(humanStderr.read()).toContain("src/api/handlers.py:1");
    expect(humanStderr.read()).toContain("fix:");

    vi.restoreAllMocks();
    const jsonStdout = captureStdout();
    const jsonStderr = captureStderr();
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    process.exitCode = 0;
    await runCli(["node", "stele", "check", "--json"]);

    const report = JSON.parse(jsonStdout.read()) as {
      ok: boolean;
      violations: Array<{
        rule_id: string;
        location: { path?: string; line?: number };
        fix?: { summary?: string };
      }>;
    };

    expect(process.exitCode).toBe(3);
    expect(jsonStderr.read()).toBe("");
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "api_boundary",
          location: expect.objectContaining({
            path: "src/api/handlers.py",
            line: 1,
          }),
          fix: expect.objectContaining({
            summary: expect.any(String),
          }),
        }),
      ]),
    );
    process.exitCode = originalExitCode;
  });
});

async function createCodeShapeProject(options: {
  contractSource: string;
  files: Record<string, string>;
}): Promise<string> {
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
      "",
      options.contractSource,
    ].join("\n"),
  );
  await writeProjectFile(
    projectDir,
    "contract/checker_impls/custom_checker.py",
    'def custom_checker(context):\n    return {"passed": True, "message": None}\n',
  );
  await writeProjectFile(
    projectDir,
    "tests/contract/conftest.py",
    "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n",
  );

  for (const [relativePath, content] of Object.entries(options.files)) {
    await writeProjectFile(projectDir, relativePath, content);
  }

  return projectDir;
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-code-shape-"));
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
