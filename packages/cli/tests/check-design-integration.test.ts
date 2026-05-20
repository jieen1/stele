import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { checkProject, isCheckCommandError } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runLock } from "../src/commands/lock.js";
import { profilePathExists } from "../src/design-profile/load.js";

const tempDirs: string[] = [];

describe("design_integrity stage in stele check", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("includes design stage violations when design profile exists and is invalid", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);

    // Create an invalid design profile (missing required project section)
    await writeProjectFile(
      projectDir,
      "contract/design/profile.yaml",
      `schema_version: 1
type_driven:
  enabled: false
`,
    );

    expect(profilePathExists(projectDir)).toBe(true);

    // The design profile is missing the required "project" section.
    // checkDesign() should report profile validation errors.
    let error: unknown;
    try {
      await checkProject(projectDir);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(isCheckCommandError(error)).toBe(true);
    const violations = error.report.violations;
    const designViolations = violations.filter(
      (v: { rule_kind: string }) => v.rule_kind === "design_integrity",
    );

    expect(designViolations.length).toBeGreaterThan(0);
    expect(designViolations[0].rule_id).toBe("design_integrity.violation");
  });

  it("skips design stage silently when no design profile exists", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);

    // Ensure no design profile exists
    expect(profilePathExists(projectDir)).toBe(false);

    // Check should pass without any design_integrity violations
    const result = await checkProject(projectDir);

    expect(result.report.ok).toBe(true);
    const designViolations = result.report.violations.filter(
      (v: { rule_kind: string }) => v.rule_kind === "design_integrity",
    );
    expect(designViolations).toEqual([]);
  });

  it("runs design stage without crashing when profile is valid", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir);

    // Create a valid minimal design profile
    await writeProjectFile(
      projectDir,
      "contract/design/profile.yaml",
      `schema_version: 1
project:
  language: typescript
  source_roots: ["src"]
  ignore: ["node_modules"]
ddd:
  bounded_context_strategy: single-bounded-context
  contexts:
    - id: core
      name: Core Domain
      subdomain_type: core
      root: src/core
      layers:
        domain: src/core/domain
        application: src/core/application
type_driven:
  enabled: false
`,
    );

    expect(profilePathExists(projectDir)).toBe(true);

    // The stage must run without crashing. Manifest/ownership may fail
    // since no generation manifest exists, which is fine — we only verify
    // the pipeline completes (either with success or with design violations).
    let succeeded = false;
    let hasDesignViolations = false;
    try {
      await checkProject(projectDir);
      succeeded = true;
    } catch (e) {
      if (isCheckCommandError(e)) {
        hasDesignViolations = e.report.violations.some(
          (v: { rule_kind: string }) => v.rule_kind === "design_integrity",
        );
      }
    }

    // Either the check passes (valid profile, no manifest to verify)
    // or it fails with design_integrity violations (manifest/ownership drift).
    // Both outcomes are valid — the key is the stage runs without crashing.
    expect(succeeded || hasDesignViolations).toBe(true);
  });
});

// ---- Helpers ----

async function createFixtureProject(): Promise<string> {
  const projectDir = await createTempDir();

  await writeProjectFile(projectDir, STELE_CONFIG_FILE, JSON.stringify({ ...DEFAULT_CONFIG }, null, 2) + "\n");
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
  const directory = await mkdtemp(join(tmpdir(), "stele-check-design-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function runGenerateAndLock(projectDir: string): Promise<void> {
  await runGenerate(projectDir, { force: false });
  await runLock(projectDir, { reason: "approved baseline" });
}
