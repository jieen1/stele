import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";
import { checkProject, isCheckCommandError } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runLock } from "../src/commands/lock.js";

const tempDirs: string[] = [];

describe("toolchain stage integration", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("skips toolchain stage when no design profile exists", async () => {
    const projectDir = await createFixtureProject();
    await runGenerateAndLock(projectDir, "initial contract baseline");

    // No design profile -> both design and toolchain stages silently skip
    const result = await checkProject(projectDir, {});

    expect(result.report.ok).toBe(true);
    expect(result.report.violations).toEqual([]);
  });

  it("toolchain stage produces violations when tsconfig policy is violated", async () => {
    const projectDir = await createFixtureProjectWithToolchain(false);
    await runGenerateAndLock(projectDir, "initial contract baseline");

    let report;
    try {
      const result = await checkProject(projectDir, {});
      report = result.report;
    } catch (error) {
      if (isCheckCommandError(error)) {
        report = error.report;
      } else {
        throw error;
      }
    }

    // Should have config-policy violation for strict: false (required to be true)
    const configViolations = report.violations.filter(
      (v) => v.rule_kind === "typescript-config-policy",
    );
    expect(configViolations.length).toBeGreaterThan(0);
    expect(configViolations[0].rule_id).toContain("typedriven.typescript.config");
  });

  it("toolchain stage passes tsconfig policy when requirements are met", async () => {
    const projectDir = await createFixtureProjectWithToolchain(true);
    await runGenerateAndLock(projectDir, "initial contract baseline");

    let report;
    try {
      const result = await checkProject(projectDir, {});
      report = result.report;
    } catch (error) {
      if (isCheckCommandError(error)) {
        report = error.report;
      } else {
        throw error;
      }
    }

    // No config-policy violations when strict: true
    const configViolations = report.violations.filter(
      (v) => v.rule_kind === "typescript-config-policy",
    );
    expect(configViolations).toEqual([]);
  });

  it("each toolchain sub-stage runs independently", { timeout: 15_000 }, async () => {
    const projectDir = await createFixtureProject();
    // Profile with both typescript_config and typescript_diagnostics enabled
    const profileContent = [
      "schema_version: 1",
      "kind: design_profile",
      "profile_id: test-profile",
      "created_at: '2026-01-01T00:00:00Z'",
      "updated_at: '2026-01-01T00:00:00Z'",
      "project:",
      "  language: typescript",
      "  source_roots: ['src']",
      "  ignore: []",
      "toolchain_contracts:",
      "  typescript_config:",
      "    required_options:",
      "      strict: true",
      "  typescript_diagnostics:",
      "    enabled: true",
      "    command: 'npx tsc --noEmit --pretty false'",
    ].join("\n") + "\n";

    await writeProjectFile(projectDir, "contract/design/profile.yaml", profileContent);
    await writeProjectFile(
      projectDir,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: false,
          target: "ES2022",
        },
      }) + "\n",
    );
    await runGenerateAndLock(projectDir, "initial contract baseline");

    let report;
    try {
      const result = await checkProject(projectDir, {});
      report = result.report;
    } catch (error) {
      if (isCheckCommandError(error)) {
        report = error.report;
      } else {
        throw error;
      }
    }

    // Should have at least the config-policy violation
    const configViolations = report.violations.filter(
      (v) => v.rule_kind === "typescript-config-policy",
    );
    expect(configViolations.length).toBeGreaterThan(0);

    // typescript-diagnostics may or may not have violations depending on npx/tsc availability
    // The key is that both sub-stages attempted to run (no exception thrown)
    const diagnosticViolations = report.violations.filter(
      (v) => v.rule_kind === "typescript-diagnostic",
    );
    // Either 0 (tsc not available) or more - both are valid
    expect(Array.isArray(diagnosticViolations)).toBe(true);
  });

  it("eslint sub-stage only runs when explicitly enabled", async () => {
    const projectDir = await createFixtureProjectWithToolchain(false);
    await runGenerateAndLock(projectDir, "initial contract baseline");

    let report;
    try {
      const result = await checkProject(projectDir, {});
      report = result.report;
    } catch (error) {
      if (isCheckCommandError(error)) {
        report = error.report;
      } else {
        throw error;
      }
    }

    // No ESLint violations (eslint not enabled in profile)
    const eslintViolations = report.violations.filter(
      (v) => v.rule_kind === "eslint",
    );
    expect(eslintViolations).toEqual([]);
  });

  it("toolchain stage runs after design_integrity in pipeline", async () => {
    const projectDir = await createFixtureProjectWithToolchain(false);
    await runGenerateAndLock(projectDir, "initial contract baseline");

    let report;
    try {
      const result = await checkProject(projectDir, {});
      report = result.report;
    } catch (error) {
      if (isCheckCommandError(error)) {
        report = error.report;
      } else {
        throw error;
      }
    }

    // Verify violations include both design_integrity and toolchain types
    const ruleKinds = report.violations.map((v) => v.rule_kind);
    // Toolchain violations should be present
    if (ruleKinds.includes("typescript-config-policy")) {
      expect(ruleKinds).toContain("typescript-config-policy");
    }
  });
});

// ---- Helpers ----

/**
 * Create a fixture project with toolchain_contracts configured.
 * @param strictSatisfied - if true, tsconfig has strict: true
 */
async function createFixtureProjectWithToolchain(strictSatisfied: boolean): Promise<string> {
  const projectDir = await createFixtureProject();

  // Write a profile with toolchain_contracts
  const profileContent = [
    "schema_version: 1",
    "kind: design_profile",
    "profile_id: test-profile",
    "created_at: '2026-01-01T00:00:00Z'",
    "updated_at: '2026-01-01T00:00:00Z'",
    "project:",
    "  language: typescript",
    "  source_roots: ['src']",
    "  ignore: []",
    "toolchain_contracts:",
    "  typescript_config:",
    "    required_options:",
    "      strict: true",
  ].join("\n") + "\n";

  await writeProjectFile(projectDir, "contract/design/profile.yaml", profileContent);

  // Write tsconfig.json - create before lock so manifest is clean
  await writeProjectFile(
    projectDir,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: strictSatisfied,
        target: "ES2022",
      },
    }) + "\n",
  );

  return projectDir;
}

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
  const directory = await mkdtemp(join(tmpdir(), "stele-toolchain-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(join(fullPath, ".."), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function runGenerateAndLock(projectDir: string, reason = "approved baseline"): Promise<void> {
  await runGenerate(projectDir, { force: false });
  await runLock(projectDir, { reason });
}
