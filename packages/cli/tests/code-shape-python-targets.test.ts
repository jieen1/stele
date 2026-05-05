import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createViolationReport, loadContract } from "@stele/core";
import { afterEach, describe, expect, it } from "vitest";
import { formatCheckReportHuman } from "../src/commands/check.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { evaluateCodeShapes } from "../src/code-shape/evaluate.js";

const tempDirs: string[] = [];

describe("code-shape python target filtering", () => {
  afterEach(async () => {
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("only evaluates Python files for broad boundary and file-policy targets", async () => {
    const projectDir = await createFixtureProject({
      contractSource: [
        "(boundary api_boundary",
        "  (lang python)",
        '  (target "src/**/*")',
        '  (deny-import "app.infrastructure"))',
        "(file-policy module_footer",
        "  (lang python)",
        '  (target "src/**/*")',
        '  (must-end-with "\\n"))',
      ].join("\n"),
      files: {
        "src/service.py": "import app.infrastructure.db\n",
        "src/broken.json": '{\n  "bad": true,\n',
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

    expect(violations).toEqual([
      expect.objectContaining({
        rule_id: "api_boundary",
        rule_kind: "rule_violation",
        location: expect.objectContaining({
          path: "src/service.py",
          line: 1,
        }),
      }),
    ]);
    expect(violations.some((violation) => violation.rule_id === "stele.check.execution_error")).toBe(false);
    expect(formatCheckReportHuman(report)).toContain("src/service.py:1");
  });
});

async function createFixtureProject(options: {
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
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-code-shape-python-targets-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}
