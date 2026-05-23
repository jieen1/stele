import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createViolationReport,
  filterViolationReport,
  formatViolationReportHuman,
  formatViolationReportJson,
  loadContract,
  normalizeContract,
  tryReadViolationBaseline,
  type Contract,
  type GeneratedVerificationResult,
  type Violation,
  type ViolationBaseline,
  type ViolationReport,
} from "@stele/core";
import { loadBackend } from "../backend-registry.js";
import { STELE_BASELINE_FILE } from "../config/defaults.js";
import type { SteleConfig } from "../config/defaults.js";
import type { CheckSummary, PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
export type { CheckSummary, PreparedCheckContext, ProtectedCheckState };
import { loadConfig } from "../config/loadConfig.js";
import { CliCommandError, ExitCode } from "../errors.js";
import { validateOutputPath } from "../utils/output-path.js";
import { writeLastReport } from "../last-report.js";
import {
  assertProtectedContractFilesReachable,
  collectProtectedPaths,
  sha256,
  toManifestPaths,
  verifyManagedGeneratedFiles,
} from "./generate.js";
import {
  collectDiffContractFiles,
  collectGitDiffScope,
  filterContractByFiles,
} from "./check-diff.js";
import { createExecutionViolation } from "./check-violations.js";
import { profilePathExists } from "../design-profile/load.js";
import { createEvent, writeEvent } from "../events/write-event.js";
import { loadProfile } from "../design-profile/load.js";
import { buildToolchainStage } from "./check-stages-toolchain.js";
import { buildProtectedStageReport } from "./check-stages-protected.js";
import {
  buildGeneratedStageReport,
  buildDesignStage,
  buildCodeShapeStageReport,
  buildArchitectureStage,
  buildComplexityStage,
} from "./check-stages-other.js";
import { buildTypeDrivenStage } from "./check-stages-type-driven.js";

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

// CheckSummary - see architecture/types.ts

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
};

export type CheckCommandResult = {
  summary: CheckSummary;
  report: ViolationReport;
};

// PreparedCheckContext, ProtectedCheckState - see architecture/types.ts

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

  // Self no-baseline check: if profile declares no_baseline: true and a baseline
  // file exists, fail immediately. This is a hard rule—cannot be bypassed by
  // --diff-from, --lenient, or any other flag.
  const selfNoBaselineViolations = await checkSelfNoBaseline(projectDir);
  if (selfNoBaselineViolations.length > 0) {
    const report = createViolationReport({
      tool: "stele",
      command: "check",
      ok: false,
      summary: {
        invariant_count: context.invariantCount,
        violation_count: selfNoBaselineViolations.length,
      },
      violations: selfNoBaselineViolations,
    });
    await persistLastReport(projectDir, report);
    throw new CheckCommandError(getCheckExitCode(report), report);
  }

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

  // Stage selection:
  // --architecture-only: run only architecture stage
  // --complexity-only: run only complexity stage
  // normal: run all stages (unless --lenient skips code-shape)
  const architectureOnly = options.architectureOnly ?? false;
  const complexityOnly = options.complexityOnly ?? false;

  if (!architectureOnly && !complexityOnly) {
    // In lenient mode, skip code-shape checks
    if (!options.lenient) {
      const codeShapeContext = changedFileSet !== undefined
        ? { ...context, contract: filterContractByFiles(context.contract, changedFileSet) }
        : context;
      reports.push(applyFiltersToReport(await buildCodeShapeStageReport(codeShapeContext, protectedState, "check"), filters));
    }
    reports.push(applyFiltersToReport(await buildDesignStage(context, protectedState, "check"), filters));
    reports.push(applyFiltersToReport(await buildToolchainStage(context, protectedState, "check"), filters));
    reports.push(applyFiltersToReport(await buildArchitectureStage(context, protectedState, "check"), filters));
    reports.push(applyFiltersToReport(await buildComplexityStage(context, protectedState, "check"), filters));
    reports.push(applyFiltersToReport(await buildTypeDrivenStage(context, protectedState, "check"), filters));
  }

  if (architectureOnly) {
    reports.push(applyFiltersToReport(await buildDesignStage(context, protectedState, "check"), filters));
    reports.push(applyFiltersToReport(await buildArchitectureStage(context, protectedState, "check"), filters));
  }

  if (complexityOnly) {
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
// Re-exports (moved to dedicated module)
// ----------------------------------------------------------------

export { runCheckRecursive, type RecursiveCheckResult } from "./check-recursive.js";

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
      await buildDesignStage(context, protectedState, command),
      await buildCodeShapeStageReport(context, protectedState, command),
      await buildToolchainStage(context, protectedState, command),
      await buildArchitectureStage(context, protectedState, command),
      await buildComplexityStage(context, protectedState, command),
      await buildTypeDrivenStage(context, protectedState, command),
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
  if (violation.rule_id.startsWith("stele.check.")) {
    return false;
  }
  if (violation.source.kind === "rule" && violation.rule_kind === "rule_violation") {
    return true;
  }
  if (violation.source.kind === "architecture" &&
      (violation.rule_kind === "architecture_dependency" ||
       violation.rule_kind === "architecture_cycle")) {
    return true;
  }
  if (violation.source.kind === "design" && violation.rule_kind === "design_integrity") {
    return true;
  }
  return false;
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
  const notices = reports.flatMap((report) => report.notices);
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
    notices,
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

export function formatCheckSummary(summary: CheckSummary, report?: ViolationReport): string {
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
  } catch (error) {
    // Swallow persistence errors so the check command's primary exit signal is
    // not perturbed by I/O quirks (read-only mount, permission denied). The
    // worst case is a stale `stele why` snapshot.
    process.stderr.write(
      "warn: failed to persist last report: " + (error instanceof Error ? error.message : String(error)) + "\n",
    );
  }
}

// ----------------------------------------------------------------
// Self no-baseline check
// ----------------------------------------------------------------

/**
 * Check whether the project's design profile declares `self_constraints.no_baseline: true`
 * and if so, verify that no baseline file exists. Returns violations if baseline found.
 *
 * This is a hard rule: cannot be bypassed by --diff-from, --lenient, or any other flag.
 */
async function checkSelfNoBaseline(projectDir: string): Promise<Violation[]> {
  if (!profilePathExists(projectDir)) {
    return [];
  }

  let profile: ReturnType<typeof loadProfile>;
  try {
    profile = loadProfile(projectDir);
  } catch {
    return [];
  }

  if (!profile.self_constraints?.no_baseline) {
    return [];
  }

  // Check for .baseline.json
  const baselinePath = resolve(projectDir, STELE_BASELINE_FILE);
  const { existsSync } = await import("node:fs");
  if (!existsSync(baselinePath)) {
    return [];
  }

  return [{
    rule_id: "stele.self.no_baseline",
    rule_kind: "rule_violation" as const,
    severity: "error" as const,
    source: { tool: "stele", command: "check", kind: "rule" },
    location: { path: STELE_BASELINE_FILE },
    cause: { summary: `Self no-baseline rule violated: ${STELE_BASELINE_FILE} exists but project design profile declares baseline files are forbidden. Delete the baseline file or remove self_constraints.no_baseline from the profile.` },
    fingerprint: "stele.self.no_baseline",
    scope_paths: [STELE_BASELINE_FILE],
    status: "active" as const,
    fix: { summary: `Delete ${STELE_BASELINE_FILE} or set self_constraints.no_baseline: false in contract/design/profile.yaml.` },
  }];
}
