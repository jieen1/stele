import { spawn, type SpawnOptions } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createViolationReport, type ViolationReport } from "@stele/core";
import { loadBackend } from "@stele/cli/backend-registry";
import type { BackendSpec, Fixture, FixtureRunResult } from "./types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STELE_CLI_ENTRY = resolve(REPO_ROOT, "packages", "cli", "dist", "index.js");

/**
 * Discover all fixtures in `tests/conformance/fixtures/`.
 *
 * A fixture directory must contain:
 *   - contract/main.stele
 *   - stele.config.json
 *   - app-state.json
 *   - expected-violations.json
 *   - README.md
 *
 * Missing files surface as fixture load errors so authors notice early.
 */
export async function loadFixtures(rootDir: string): Promise<Fixture[]> {
  const absoluteRoot = resolve(rootDir);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const fixtureDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  const fixtures: Fixture[] = [];

  for (const id of fixtureDirs) {
    fixtures.push(await loadFixture(id, join(absoluteRoot, id)));
  }

  return fixtures;
}

async function loadFixture(id: string, dir: string): Promise<Fixture> {
  const [appState, expectedViolations, baseConfig] = await Promise.all([
    readJsonFile(join(dir, "app-state.json"), `${id}/app-state.json`),
    readJsonFile(join(dir, "expected-violations.json"), `${id}/expected-violations.json`),
    readJsonFile(join(dir, "stele.config.json"), `${id}/stele.config.json`),
  ]);

  if (!isPlainObject(baseConfig)) {
    throw new Error(`Fixture ${id}: stele.config.json must be a JSON object.`);
  }

  if (!isViolationReportShape(expectedViolations)) {
    throw new Error(`Fixture ${id}: expected-violations.json must match ViolationReport schema.`);
  }

  return {
    id,
    dir,
    appState,
    expectedViolations,
    baseConfig: { ...baseConfig },
    // EP06: Code-shape fixtures only run on the Python backend in v0.2.
    // The TypeScript backend tests skip via runner.ts when this flag is set.
    requiresCodeShape: id.includes("code-shape"),
  };
}

/**
 * Parse STELE_CONFORMANCE_BACKENDS env value.
 *
 * Format: `<lang>:<framework>[,<lang>:<framework>...]`. Default: "python:pytest".
 */
export function parseBackendSpecs(value: string | undefined): BackendSpec[] {
  const raw = value && value.length > 0 ? value : "python:pytest";

  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const [language, framework] = trimmed.split(":");

    if (!language || !framework) {
      throw new Error(`Bad STELE_CONFORMANCE_BACKENDS spec: ${entry}`);
    }

    return { language, framework };
  });
}

/**
 * Run a fixture against one backend.
 *
 * 1. Make tmpdir
 * 2. Copy fixture (contract/, stele.config.json) into tmpdir
 * 3. Inject targetLanguage/testFramework into stele.config.json
 * 4. Build CLI lookup, then invoke `stele generate`
 * 5. Call `backend.writeFixtureBootstrap(fixture, tmpdir)` if defined
 * 6. Run the configured test runner (pytest etc.) — skip cleanly when missing
 * 7. Run `stele check --json` to capture drift report
 * 8. Combine results into a ViolationReport
 * 9. Cleanup tmpdir
 */
export async function runFixtureOnBackend(fixture: Fixture, spec: BackendSpec): Promise<FixtureRunResult> {
  const workDir = await mkdtemp(join(tmpdir(), `stele-conformance-${fixture.id}-${spec.language}-`));

  try {
    return await executeFixtureRun(fixture, spec, workDir);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function executeFixtureRun(fixture: Fixture, spec: BackendSpec, workDir: string): Promise<FixtureRunResult> {
  await assertCliBuilt();
  await copyFixtureSources(fixture.dir, workDir);
  await injectBackendIntoConfig(workDir, spec);

  await runCli(["generate", "--force"], workDir);

  const backend = await loadBackend(spec.language, spec.framework);

  if (typeof backend.writeFixtureBootstrap === "function") {
    await backend.writeFixtureBootstrap(
      {
        id: fixture.id,
        dir: fixture.dir,
        appState: fixture.appState,
      },
      workDir,
    );
  }

  // Lock AFTER fixture bootstrap so conftest.py / setup_test.go / etc. are
  // captured by the manifest and `stele check` produces a clean drift report.
  await runCli(["lock", "--reason", "conformance suite"], workDir);

  const runnerStatus = await runFrameworkTests(spec, workDir);
  const driftReport = await runCheckJson(workDir);
  const report = mergeReports(driftReport, runnerStatus);

  return {
    report,
    runnerExitCode: runnerStatus.exitCode,
    runnerSkipped: runnerStatus.skipped,
    runnerSkipReason: runnerStatus.skipReason,
  };
}

type RunnerStatus = {
  exitCode: number | null;
  skipped: boolean;
  skipReason?: string;
  stderr?: string;
};

async function runFrameworkTests(spec: BackendSpec, workDir: string): Promise<RunnerStatus> {
  if (spec.language === "python" && spec.framework === "pytest") {
    return runPytest(workDir);
  }

  if (spec.language === "go" && spec.framework === "testing") {
    return runGoTest(workDir);
  }

  if (spec.language === "rust" && spec.framework === "cargo-test") {
    return runCargoTest(workDir);
  }

  if (spec.language === "java" && spec.framework === "junit5") {
    return runMavenTest(workDir);
  }

  if (spec.language === "typescript" && spec.framework === "vitest") {
    // Fixture directories don't ship a populated node_modules with vitest;
    // until EP01 Phase D wires that up the runner skips cleanly so the
    // conformance suite stays green when STELE_CONFORMANCE_BACKENDS includes
    // "typescript:vitest".
    return {
      exitCode: null,
      skipped: true,
      skipReason: "vitest runner not yet wired in conformance runner",
    };
  }

  return {
    exitCode: null,
    skipped: true,
    skipReason: `${spec.language}:${spec.framework} test runner not yet wired in conformance runner`,
  };
}

async function runPytest(workDir: string): Promise<RunnerStatus> {
  const pytestAvailable = await isPytestAvailable();

  if (!pytestAvailable) {
    return {
      exitCode: null,
      skipped: true,
      skipReason: "pytest not installed",
    };
  }

  const result = await runProcess("python3", ["-m", "pytest", "tests/contract", "-q"], { cwd: workDir });

  return {
    exitCode: result.exitCode ?? -1,
    skipped: false,
    stderr: result.stderr,
  };
}

async function isPytestAvailable(): Promise<boolean> {
  const result = await runProcess("python3", ["-c", "import pytest"], {});
  return result.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Go test runner
// ---------------------------------------------------------------------------

async function runGoTest(workDir: string): Promise<RunnerStatus> {
  const goAvailable = await isGoAvailable();

  if (!goAvailable) {
    return {
      exitCode: null,
      skipped: true,
      skipReason: "go not installed",
    };
  }

  const result = await runProcess("go", ["test", "./..."], { cwd: workDir });

  return {
    exitCode: result.exitCode ?? -1,
    skipped: false,
    stderr: result.stderr,
  };
}

async function isGoAvailable(): Promise<boolean> {
  try {
    const result = await runProcess("go", ["version"], {});
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rust test runner (cargo)
// ---------------------------------------------------------------------------

async function runCargoTest(workDir: string): Promise<RunnerStatus> {
  const cargoAvailable = await isCargoAvailable();

  if (!cargoAvailable) {
    return {
      exitCode: null,
      skipped: true,
      skipReason: "cargo not installed",
    };
  }

  const result = await runProcess("cargo", ["test"], { cwd: workDir });

  return {
    exitCode: result.exitCode ?? -1,
    skipped: false,
    stderr: result.stderr,
  };
}

async function isCargoAvailable(): Promise<boolean> {
  try {
    const result = await runProcess("cargo", ["--version"], {});
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Java test runner (Maven)
// ---------------------------------------------------------------------------

async function runMavenTest(workDir: string): Promise<RunnerStatus> {
  const mavenAvailable = await isMavenAvailable();

  if (!mavenAvailable) {
    return {
      exitCode: null,
      skipped: true,
      skipReason: "mvn not installed",
    };
  }

  const result = await runProcess("mvn", ["test"], { cwd: workDir });

  return {
    exitCode: result.exitCode ?? -1,
    skipped: false,
    stderr: result.stderr,
  };
}

async function isMavenAvailable(): Promise<boolean> {
  try {
    const result = await runProcess("mvn", ["--version"], {});
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function runCli(args: string[], cwd: string): Promise<void> {
  const result = await runProcess("node", [STELE_CLI_ENTRY, ...args], { cwd });

  if (result.exitCode !== 0) {
    throw new Error(
      `stele ${args.join(" ")} failed in ${cwd} (exit ${result.exitCode}). stdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
}

async function runCheckJson(workDir: string): Promise<ViolationReport> {
  const result = await runProcess("node", [STELE_CLI_ENTRY, "check", "--json"], { cwd: workDir });

  // `stele check --json` emits the report on stdout regardless of pass/fail.
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `stele check --json produced no output in ${workDir} (exit ${result.exitCode}). stderr=${result.stderr}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse stele check --json output: ${message}\nstdout=${result.stdout}`);
  }

  if (!isViolationReportShape(parsed)) {
    throw new Error(`stele check --json output is not a ViolationReport: ${result.stdout}`);
  }

  return parsed;
}

async function assertCliBuilt(): Promise<void> {
  try {
    const stats = await stat(STELE_CLI_ENTRY);

    if (!stats.isFile()) {
      throw new Error(`Stele CLI entry is not a file: ${STELE_CLI_ENTRY}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Stele CLI not built at ${STELE_CLI_ENTRY}. Run 'pnpm build' before pnpm test:conformance. (${message})`,
    );
  }
}

async function copyFixtureSources(fixtureDir: string, workDir: string): Promise<void> {
  await cp(join(fixtureDir, "contract"), join(workDir, "contract"), { recursive: true });
  await cp(join(fixtureDir, "stele.config.json"), join(workDir, "stele.config.json"));
  // EP06 code-shape fixtures ship an `app/` tree containing the Python
  // module(s) the contract targets. Copy it when present so the generated
  // pytest can resolve modules via importlib.
  await maybeCopyOptionalDir(join(fixtureDir, "app"), join(workDir, "app"));

  // Language-specific project files for non-Python backends.
  // Copy them when present so the test runner can compile and execute.
  await maybeCopyOptionalFile(join(fixtureDir, "Cargo.toml"), join(workDir, "Cargo.toml"));
  await maybeCopyOptionalFile(join(fixtureDir, "Cargo.lock"), join(workDir, "Cargo.lock"));
  await maybeCopyOptionalFile(join(fixtureDir, "go.mod"), join(workDir, "go.mod"));
  await maybeCopyOptionalFile(join(fixtureDir, "pom.xml"), join(workDir, "pom.xml"));
  // Rust needs an empty src/lib.rs so `cargo test` can compile.
  await maybeCopyOptionalDir(join(fixtureDir, "src"), join(workDir, "src"));
}

async function maybeCopyOptionalDir(sourceDir: string, destDir: string): Promise<void> {
  try {
    const stats = await stat(sourceDir);
    if (!stats.isDirectory()) {
      return;
    }
  } catch {
    return;
  }
  await cp(sourceDir, destDir, { recursive: true });
}

async function maybeCopyOptionalFile(sourceFile: string, destFile: string): Promise<void> {
  try {
    const stats = await stat(sourceFile);
    if (!stats.isFile()) {
      return;
    }
  } catch {
    return;
  }
  await cp(sourceFile, destFile);
}

async function injectBackendIntoConfig(workDir: string, spec: BackendSpec): Promise<void> {
  const configPath = join(workDir, "stele.config.json");
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  parsed.targetLanguage = spec.language;
  parsed.testFramework = spec.framework;

  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * Merge `stele check --json` drift report with framework runner status.
 *
 * v0.2 keeps this simple: drift report is returned as-is. EP07 will plug in
 * per-invariant pass/fail violations parsed from junitxml.
 */
function mergeReports(driftReport: ViolationReport, runner: RunnerStatus): ViolationReport {
  if (runner.skipped || runner.exitCode === 0 || runner.exitCode === null) {
    return driftReport;
  }

  // Test runner failure indicates an invariant violation. v0.2 cannot map it
  // to per-rule Violations yet, so a placeholder is appended (rule_kind:
  // "invariant") so callers can detect failure presence.
  const placeholder = createViolationReport({
    tool: "@stele/cli",
    command: "check",
    ok: false,
    summary: {
      violation_count: 1,
      active_violation_count: 1,
    },
    violations: [
      {
        rule_id: "stele.conformance.test_runner_failure",
        rule_kind: "invariant",
        severity: "error",
        source: { tool: "@stele/cli", command: "check", kind: "test-runner" },
        location: { path: "tests/contract" },
        cause: {
          summary: "Test runner reported invariant failures.",
          detail: runner.stderr,
        },
        scope_paths: ["tests/contract"],
      },
    ],
  });

  const allViolations = [...driftReport.violations, ...placeholder.violations];

  return createViolationReport({
    tool: driftReport.tool,
    command: driftReport.command,
    ok: false,
    summary: {
      ...driftReport.summary,
      violation_count: allViolations.length,
      active_violation_count: (driftReport.summary.active_violation_count ?? driftReport.violations.length) + 1,
    },
    violations: allViolations,
  });
}

type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function runProcess(command: string, args: string[], options: SpawnOptions): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;

    try {
      child = spawn(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code) => {
      resolvePromise({ exitCode: code, stdout, stderr });
    });
  });
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} (${path}): ${message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} as JSON (${path}): ${message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isViolationReportShape(value: unknown): value is ViolationReport {
  return (
    isPlainObject(value) &&
    value.schema_version === "1" &&
    typeof value.tool === "string" &&
    typeof value.command === "string" &&
    typeof value.ok === "boolean" &&
    isPlainObject(value.summary) &&
    Array.isArray(value.violations)
  );
}
