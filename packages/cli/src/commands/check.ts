import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SteleError,
  createViolationReport,
  filterViolationReport,
  formatViolationReportHuman,
  formatViolationReportJson,
  loadContract,
  normalizeContract,
  tryReadViolationBaseline,
  verifyManifest,
  type Contract,
  type ContractFile,
  type GeneratedVerificationResult,
  type HumanState,
  type VerificationResult,
  type Violation,
  type ViolationBaseline,
  type ViolationReport,
} from "@stele/core";
import { loadBackend } from "../backend-registry.js";
import { STELE_BASELINE_FILE, type SteleConfig } from "../config/defaults.js";
import { loadConfig } from "../config/loadConfig.js";
import { evaluateCodeShapes } from "../code-shape/evaluate.js";
import { buildArchitectureStageReport } from "../architecture/stage.js";
import { evaluateCoreNodes } from "../complexity/evaluate.js";
import { computeHumanState } from "./baseline.js";
import { CliCommandError, ExitCode, getExitCode } from "../errors.js";
import { validateOutputPath } from "../utils/output-path.js";
import { writeLastReport } from "../last-report.js";
import { discoverProjects } from "../recursive-discovery.js";
import {
  assertProtectedContractFilesReachable,
  collectProtectedPaths,
  sha256,
  toManifestPaths,
  verifyManagedGeneratedFiles,
} from "./generate.js";
import { aggregateExitCode, formatRecursiveHeader, formatRecursiveSummary, type SubReport } from "./recursive.js";
import {
  collectDiffContractFiles,
  collectGitDiffScope,
  filterContractByFiles,
} from "./check-diff.js";
import {
  createContractHashMismatchViolation,
  createExecutionViolation,
  createGeneratedDriftViolation,
  createHumanFileDriftViolation,
  createManifestDriftViolation,
  createProtectedFileDriftViolation,
} from "./check-violations.js";
import { createEvent, writeEvent } from "../events/write-event.js";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export type CheckSummary = {
  invariantCount: number;
  generatedFileCount: number;
  protectedFileCount: number;
};

export type CheckCommandOptions = {
  diff?: string | true;
  diffFrom?: string;
  format?: string;
  json?: boolean;
  reportFile?: string;
  lenient?: boolean;
  recursive?: boolean;
  architectureOnly?: boolean;
  complexityOnly?: boolean;
  complexity?: boolean;
};

export type RecursiveCheckResult = {
  exitCode: number;
  subReports: SubReport[];
  jsonOutput?: string;
};

export type CheckCommandResult = {
  summary: CheckSummary;
  report: ViolationReport;
};

export type PreparedCheckContext = {
  projectDir: string;
  config: SteleConfig;
  contract: Contract;
  generated: GeneratedVerificationResult;
  invariantCount: number;
};

export type ProtectedCheckState = {
  protectedPaths: string[];
  contractHash: string;
  summary: CheckSummary;
};

type CheckFilters = {
  baseline?: ViolationBaseline;
  diffScopePaths?: string[];
};

// ----------------------------------------------------------------
// Entry points
// ----------------------------------------------------------------

export async function runCheck(projectDir: string, options: CheckCommandOptions = {}): Promise<void> {
  await checkProject(projectDir, options);
}

export async function checkProject(projectDir: string, options: CheckCommandOptions = {}): Promise<CheckCommandResult> {
  // --diff: compute changed contract files upfront (always, even if not used yet).
  let changedFileSet: Set<string> | undefined;
  if (options.diff !== undefined) {
    const ref = options.diff === true ? "HEAD" : options.diff;
    const changedFiles = await collectDiffContractFiles(projectDir, ref);

    changedFileSet = new Set(changedFiles);
  }

  // Always verify generated + protected files against the FULL contract.
  const context = await prepareCheckContext(projectDir);
  const filters = await prepareCheckFilters(context, options);
  const generatedReport = applyFiltersToReport(buildGeneratedStageReport(context, "check"), filters);

  if (!generatedReport.ok) {
    await recordViolationEvent(projectDir, generatedReport);
    await persistLastReport(projectDir, generatedReport);
    throw new CheckCommandError(getCheckExitCode(generatedReport), generatedReport);
  }

  const protectedState = await collectProtectedCheckState(projectDir, context.config, context.contract, context.generated);
  const reports: ViolationReport[] = [
    generatedReport,
    applyFiltersToReport(await buildProtectedStageReport(context, protectedState, "check"), filters),
  ];

  // In lenient mode, skip code-shape checks (only check generated + protected)
  if (!options.lenient) {
    // --diff: only evaluate code shapes for invariants in changed files.
    const codeShapeContext = changedFileSet !== undefined
      ? { ...context, contract: filterContractByFiles(context.contract, changedFileSet) }
      : context;
    reports.push(applyFiltersToReport(await buildCodeShapeStageReport(codeShapeContext, protectedState, "check"), filters));
  }

  // Architecture stage (always runs unless --complexity-only)
  if (!options.complexityOnly) {
    reports.push(applyFiltersToReport(await buildArchitectureStage(context, protectedState, "check"), filters));
  }

  // Complexity stage (always runs unless --architecture-only or --no-complexity)
  if (!options.architectureOnly && options.complexity !== false) {
    reports.push(applyFiltersToReport(await buildComplexityStage(context, protectedState, "check"), filters));
  }

  const report = mergeCheckReports(reports);

  if (!report.ok) {
    await recordViolationEvent(projectDir, report);
    await persistLastReport(projectDir, report);
    throw new CheckCommandError(getCheckExitCode(report), report);
  }

  const finalReport = withCheckSummary(report, protectedState.summary);
  await persistLastReport(projectDir, finalReport);

  return {
    summary: protectedState.summary,
    report: finalReport,
  };
}

// ----------------------------------------------------------------
// Recursive check
// ----------------------------------------------------------------

export async function runCheckRecursive(
  rootDir: string,
  options: CheckCommandOptions,
  output: { stdout: (chunk: string) => void; stderr: (chunk: string) => void },
): Promise<RecursiveCheckResult> {
  const projects = await discoverProjects(rootDir);

  if (projects.length === 0) {
    throw new SteleError(
      "E_NO_PROJECTS_FOUND",
      "RecursiveError",
      `No stele.config.json found under ${rootDir}. Run 'stele init' in a sub-directory first.`,
      undefined,
      undefined,
      "Run 'stele init' in a sub-directory or change to a directory containing Stele projects.",
    );
  }

  if (!options.json) {
    output.stdout(formatRecursiveHeader(projects));
  }

  const subReports: SubReport[] = [];
  const subOptions: CheckCommandOptions = { ...options, recursive: false, json: false, reportFile: undefined };

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    const indexLabel = `[${i + 1}/${projects.length}]`;

    if (!options.json) {
      output.stdout(`${indexLabel} checking ${project}\n`);
    }

    const subReport = await runSingleProjectCheck(project, subOptions);
    subReports.push(subReport);

    if (!options.json) {
      const status =
        subReport.exit_code === 0
          ? `  passed (${subReport.summary.invariant_count ?? 0} invariants, ${subReport.summary.violation_count ?? 0} violations)`
          : `  failed (exit ${subReport.exit_code}): ${subReport.summary.violation_count ?? 0} violation${subReport.summary.violation_count === 1 ? "" : "s"}`;
      output.stdout(`${status}\n\n`);
    }
  }

  const exitCode = aggregateExitCode(subReports);

  if (options.json) {
    const passed = subReports.filter((report) => report.exit_code === 0).length;
    const failed = subReports.length - passed;
    const aggregate = {
      schema_version: "1" as const,
      tool: "@stele/cli",
      command: "check",
      generated_at: new Date().toISOString(),
      cwd: rootDir,
      projects: subReports,
      max_exit_code: exitCode,
      passed,
      failed,
    };
    const jsonOutput = `${JSON.stringify(aggregate, null, 2)}\n`;
    output.stdout(jsonOutput);
    return { exitCode, subReports, jsonOutput };
  }

  output.stdout(formatRecursiveSummary(subReports));
  return { exitCode, subReports };
}

async function runSingleProjectCheck(projectDir: string, options: CheckCommandOptions): Promise<SubReport> {
  try {
    const result = await checkProject(projectDir, options);
    return {
      project: projectDir,
      exit_code: 0,
      summary: {
        invariant_count: result.summary.invariantCount,
        generated_file_count: result.summary.generatedFileCount,
        protected_file_count: result.summary.protectedFileCount,
        violation_count: result.report.summary.violation_count ?? 0,
      },
      violations: result.report.violations,
    };
  } catch (error) {
    if (isCheckCommandError(error)) {
      return {
        project: projectDir,
        exit_code: error.exitCode,
        summary: {
          invariant_count: error.report.summary.invariant_count,
          generated_file_count: error.report.summary.generated_file_count,
          protected_file_count: error.report.summary.protected_file_count,
          violation_count: error.report.summary.violation_count ?? 0,
        },
        violations: error.report.violations,
      };
    }

    const exitCode = getExitCode(error) ?? 1;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof SteleError ? error.code : undefined;

    return {
      project: projectDir,
      exit_code: exitCode,
      summary: { violation_count: 0 },
      error: { message, code },
    };
  }
}

// ----------------------------------------------------------------
// Context preparation
// ----------------------------------------------------------------

export async function prepareCheckContext(projectDir: string): Promise<PreparedCheckContext> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  return prepareCheckContextWithContract(projectDir, contract);
}

export async function prepareCheckContextWithContract(projectDir: string, contract: Contract): Promise<PreparedCheckContext> {
  const config = await loadConfig(projectDir);
  const backend = await loadBackend(config.targetLanguage, config.testFramework);
  const generated = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  return {
    projectDir,
    config,
    contract,
    generated,
    invariantCount: contract.invariants.length,
  };
}

export async function collectProtectedCheckState(
  projectDir: string,
  config: SteleConfig,
  contract: Contract,
  generated: GeneratedVerificationResult,
): Promise<ProtectedCheckState> {
  const protectedPaths = await collectProtectedPaths(projectDir, config);
  await assertProtectedContractFilesReachable(projectDir, config.entry, protectedPaths, contract);

  return {
    protectedPaths,
    contractHash: sha256(normalizeContract(contract)),
    summary: {
      invariantCount: contract.invariants.length,
      generatedFileCount: generated.files.length,
      protectedFileCount: toManifestPaths(projectDir, protectedPaths).length,
    },
  };
}

// ----------------------------------------------------------------
// Raw check (programmatic API)
// ----------------------------------------------------------------

export async function buildRawCheckReport(context: PreparedCheckContext, command = "check"): Promise<ViolationReport> {
  const generatedReport = buildGeneratedStageReport(context, command);

  if (!context.generated.ok) {
    return generatedReport;
  }

  try {
    const protectedState = await collectProtectedCheckState(context.projectDir, context.config, context.contract, context.generated);
    return mergeCheckReports([
      generatedReport,
      await buildProtectedStageReport(context, protectedState, command),
      await buildCodeShapeStageReport(context, protectedState, command),
      await buildArchitectureStage(context, protectedState, command),
      await buildComplexityStage(context, protectedState, command),
    ]);
  } catch (error) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: context.invariantCount,
        generated_file_count: context.generated.files.length,
        violation_count: 1,
      },
      violations: [createExecutionViolation(error, context.config.entry, command)],
    });
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

export function isCheckCommandError(error: unknown): error is CheckCommandError {
  return error instanceof CheckCommandError;
}

export function isBaselineEligibleViolation(violation: Violation): boolean {
  return (
    violation.source.kind === "rule" &&
    violation.rule_kind === "rule_violation" &&
    !violation.rule_id.startsWith("stele.check.")
  );
}

function isCheckSuppressibleViolation(violation: Violation): boolean {
  return isBaselineEligibleViolation(violation) && violation.scope_paths.length > 0;
}

async function prepareCheckFilters(context: PreparedCheckContext, options: CheckCommandOptions): Promise<CheckFilters> {
  return {
    baseline: await tryReadViolationBaseline(resolve(context.projectDir, STELE_BASELINE_FILE)),
    diffScopePaths: options.diffFrom === undefined ? undefined : await collectGitDiffScope(context.projectDir, options.diffFrom),
  };
}

function applyFiltersToReport(report: ViolationReport, filters: CheckFilters): ViolationReport {
  return filterViolationReport(report, {
    baseline: report.violations.some((violation) => violation.scope_paths.includes(STELE_BASELINE_FILE)) ? undefined : filters.baseline,
    diffScopePaths: filters.diffScopePaths,
    isSuppressible: isCheckSuppressibleViolation,
  });
}

// ----------------------------------------------------------------
// Report building
// ----------------------------------------------------------------

function mergeCheckReports(reports: ViolationReport[]): ViolationReport {
  const violations = reports.flatMap((report) => report.violations);
  const activeViolationCount = violations.filter((violation) => (violation.status ?? "active") === "active").length;
  const suppressedViolationCount = violations.filter((violation) => violation.status === "suppressed").length;
  const outOfScopeViolationCount = violations.filter((violation) => violation.status === "out_of_scope").length;
  const lastSummary = [...reports]
    .reverse()
    .find((report) => report.summary.invariant_count !== undefined)?.summary;

  return createViolationReport({
    tool: reports[reports.length - 1]?.tool ?? "stele",
    command: reports[reports.length - 1]?.command ?? "check",
    ok: activeViolationCount === 0,
    summary: {
      invariant_count: lastSummary?.invariant_count,
      generated_file_count: lastSummary?.generated_file_count,
      protected_file_count: lastSummary?.protected_file_count,
      violation_count: violations.length,
      active_violation_count: activeViolationCount,
      suppressed_violation_count: suppressedViolationCount,
      out_of_scope_violation_count: outOfScopeViolationCount,
    },
    violations,
  });
}

function buildGeneratedStageReport(context: PreparedCheckContext, command: string): ViolationReport {
  if (!context.generated.ok) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: context.invariantCount,
        generated_file_count: context.generated.files.length,
        violation_count: 1,
      },
      violations: [createGeneratedDriftViolation(context.config.entry, context.config.generatedDir, context.generated, command)],
    });
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: true,
    summary: {
      invariant_count: context.invariantCount,
      generated_file_count: context.generated.files.length,
      violation_count: 0,
    },
    violations: [],
  });
}

async function buildProtectedStageReport(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  try {
    const baseline = await tryReadViolationBaseline(resolve(context.projectDir, STELE_BASELINE_FILE));
    const humanState = baseline?.human_state;

    if (humanState !== undefined) {
      return buildProtectedReportWithBaseline(context, protectedState, humanState, command);
    }

    return buildProtectedReportWithManifest(context, protectedState, command);
  } catch (error) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        generated_file_count: protectedState.summary.generatedFileCount,
        protected_file_count: protectedState.summary.protectedFileCount,
        violation_count: 1,
      },
      violations: [createExecutionViolation(error, context.config.entry, command)],
    });
  }
}

/**
 * Protected-stage report when baseline has human_state.
 *
 * Compares current human file hashes against the recorded baseline state.
 * If human files match, skips manifest verification entirely (the manifest
 * will naturally drift from human-authored files).
 * If human files drift from baseline, reports human_file_drift violations.
 */
async function buildProtectedReportWithBaseline(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  humanState: HumanState,
  command: string,
): Promise<ViolationReport> {
  const currentHumanState = await computeHumanState(
    context.projectDir,
    context.config,
    protectedState.contractHash,
  );

  const driftedFiles: string[] = [];
  for (const [path, baselineHash] of Object.entries(humanState.files)) {
    if (currentHumanState.files[path] !== baselineHash) {
      driftedFiles.push(path);
    }
  }

  for (const path of Object.keys(currentHumanState.files)) {
    if (humanState.files[path] === undefined) {
      driftedFiles.push(path);
    }
  }

  driftedFiles.sort();

  const violations: ReturnType<typeof createHumanFileDriftViolation>[] = [];

  if (driftedFiles.length > 0 || currentHumanState.contract_hash !== humanState.contract_hash) {
    violations.push(
      createHumanFileDriftViolation(
        STELE_BASELINE_FILE,
        humanState,
        currentHumanState,
        command,
      ),
    );
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      generated_file_count: protectedState.summary.generatedFileCount,
      protected_file_count: protectedState.summary.protectedFileCount,
      violation_count: violations.length,
    },
    violations,
  });
}

/**
 * Protected-stage report using manifest verification (no baseline human_state).
 * This is the original behavior when no baseline exists.
 */
async function buildProtectedReportWithManifest(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const manifest = await verifyManifest(resolve(context.projectDir, context.config.manifestPath));
  const currentProtectedPaths = toManifestPaths(context.projectDir, protectedState.protectedPaths);
  const manifestProtectedPathSet = new Set(manifest.files.map((file) => file.path));
  const violations = [
    ...(!manifest.ok ? [createManifestDriftViolation(context.config.manifestPath, manifest, command)] : []),
    ...currentProtectedPaths
      .filter((path) => !manifestProtectedPathSet.has(path))
      .map((path) => createProtectedFileDriftViolation(context.config.manifestPath, [path], command)),
  ];

  if (manifest.contractHash !== protectedState.contractHash) {
    violations.push(
      createContractHashMismatchViolation(
        context.config.entry,
        context.config.manifestPath,
        manifest.contractHash,
        protectedState.contractHash,
        command,
      ),
    );
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      generated_file_count: protectedState.summary.generatedFileCount,
      protected_file_count: protectedState.summary.protectedFileCount,
      violation_count: violations.length,
    },
    violations,
  });
}

async function buildCodeShapeStageReport(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const violations = await evaluateCodeShapes(context.projectDir, context.contract, command);

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      generated_file_count: protectedState.summary.generatedFileCount,
      protected_file_count: protectedState.summary.protectedFileCount,
      violation_count: violations.length,
    },
    violations,
  });
}

async function buildArchitectureStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  return buildArchitectureStageReport(context, protectedState, command);
}

async function buildComplexityStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const coreNodes = context.contract.coreNodes;

  if (coreNodes.length === 0) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        violation_count: 0,
      },
      violations: [],
    });
  }

  const results = await evaluateCoreNodes(context.projectDir, coreNodes);

  const violations: Violation[] = [];
  for (const result of results) {
    for (const v of result.violations) {
      const detail = `Complexity violation: ${v.metric} value ${v.value} exceeds max ${v.max} for core-node "${result.measurement.id}"`;
      violations.push({
        rule_id: `complexity.${result.measurement.id}.${v.metric}`,
        rule_kind: "rule_violation" as const,
        severity: "error" as const,
        source: { tool: "stele", command, kind: "rule" },
        location: { path: result.measurement.filePath },
        cause: { summary: detail },
        fingerprint: `complexity.${result.measurement.id}.${v.metric}`,
        scope_paths: [result.measurement.filePath],
        status: "active" as const,
        fix: { summary: `Reduce ${v.metric} of "${result.measurement.className}" below ${v.max}.` },
      });
    }
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      violation_count: violations.length,
    },
    violations,
  });
}

// ----------------------------------------------------------------
// Summary and formatting
// ----------------------------------------------------------------

function withCheckSummary(report: ViolationReport, summary: CheckSummary): ViolationReport {
  return {
    ...report,
    summary: {
      ...report.summary,
      message: formatCheckSummary(summary, report).trimEnd(),
      invariant_count: summary.invariantCount,
      generated_file_count: summary.generatedFileCount,
      protected_file_count: summary.protectedFileCount,
    },
  };
}

function getCheckExitCode(report: ViolationReport): ExitCode {
  const activeViolations = report.violations.filter((violation) => (violation.status ?? "active") === "active");
  return activeViolations.length > 0 && activeViolations.every((violation) => violation.rule_kind === "generated_drift")
    ? ExitCode.CONTRACT_FAIL
    : ExitCode.TAMPER_DETECTED;
}

function formatCheckSummary(summary: CheckSummary, report?: ViolationReport): string {
  const suffixes: string[] = [];
  const suppressedCount = report?.summary.suppressed_violation_count ?? 0;
  const outOfScopeCount = report?.summary.out_of_scope_violation_count ?? 0;

  if (suppressedCount > 0) {
    suffixes.push(`${suppressedCount} baseline violation${suppressedCount === 1 ? "" : "s"} suppressed`);
  }

  if (outOfScopeCount > 0) {
    suffixes.push(`${outOfScopeCount} out-of-scope violation${outOfScopeCount === 1 ? "" : "s"} ignored`);
  }

  return `OK ${summary.invariantCount} invariant${summary.invariantCount === 1 ? "" : "s"} checked; ${summary.generatedFileCount} generated file${summary.generatedFileCount === 1 ? "" : "s"} and ${summary.protectedFileCount} protected file${summary.protectedFileCount === 1 ? "" : "s"} verified${suffixes.length > 0 ? ` (${suffixes.join(", ")})` : ""}.\n`;
}

// ----------------------------------------------------------------
// Public formatting API
// ----------------------------------------------------------------

export function formatCheckSummaryPublic(summary: CheckSummary, report?: ViolationReport): string {
  return formatCheckSummary(summary, report);
}

export function formatCheckReportHuman(report: ViolationReport): string {
  return formatViolationReportHuman(report);
}

export function formatCheckReportJson(report: ViolationReport): string {
  return formatViolationReportJson(report);
}

export async function writeCheckReportFile(projectDir: string, reportFile: string, report: ViolationReport): Promise<void> {
  const absoluteReportPath = validateOutputPath(projectDir, reportFile);
  await mkdir(dirname(absoluteReportPath), { recursive: true });
  await writeFile(absoluteReportPath, formatViolationReportJson(report), "utf8");
}

// ----------------------------------------------------------------
// Diff helpers
// ----------------------------------------------------------------

export function createDiffNoChangesResult(changedFiles: string[]): CheckCommandResult {
  const report = createViolationReport({
    tool: "stele",
    command: "check",
    ok: true,
    summary: {
      message: `No contract changes detected (${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"})`,
      invariant_count: 0,
      generated_file_count: 0,
      protected_file_count: 0,
      violation_count: 0,
    },
    violations: [],
  });

  return {
    summary: {
      invariantCount: 0,
      generatedFileCount: 0,
      protectedFileCount: 0,
    },
    report,
  };
}

// ----------------------------------------------------------------
// Error classes
// ----------------------------------------------------------------

class CheckCommandError extends CliCommandError {
  constructor(
    exitCode: ExitCode,
    readonly report: ViolationReport,
    cause?: unknown,
  ) {
    super(formatViolationReportHuman(report).trimEnd(), exitCode, cause);
    this.name = "CheckCommandError";
  }
}

// ----------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------

async function recordViolationEvent(projectDir: string, report: ViolationReport): Promise<void> {
  const activeViolations = report.violations.filter((v) => (v.status ?? "active") === "active");
  await writeEvent(
    projectDir,
    createEvent("violation-detected", projectDir, {
      violation_count: activeViolations.length,
      violation_ids: activeViolations.map((v) => v.rule_id),
    }),
  );
}

async function persistLastReport(projectDir: string, report: ViolationReport): Promise<void> {
  try {
    await writeLastReport(projectDir, report);
  } catch {
    // Swallow persistence errors so the check command's primary exit signal is
    // not perturbed by I/O quirks (read-only mount, permission denied). The
    // worst case is a stale `stele why` snapshot.
  }
}
