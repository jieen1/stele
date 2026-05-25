import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  annotateCrossRuleViolations,
  createViolationReport,
  formatViolationReportHuman,
  formatViolationReportJson,
  loadContract,
  normalizeContract,
  ruleId,
  tryReadViolationBaseline,
  type Contract,
  type GeneratedVerificationResult,
  type Violation,
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
  computeSha256,
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
import {
  loadHashedProfile,
  useHashedProfile,
} from "../design-profile/lifecycle.js";
import { runAllStages } from "./check-stages-registry.js";
import { isBaselineEligibleViolation, type ReportFilters } from "../report/filters.js";

export { isBaselineEligibleViolation };

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
  // When --diff is active, the code-shape stage uses a narrowed contract
  // (only changed files) via `codeShapeContract`; all other stages keep
  // the full contract.
  const context = await prepareCheckContext(projectDir, changedFileSet);

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

  // Generated-drift short-circuit: preserves v0.1 semantics where downstream
  // stages and the protected-state collector never run against a project
  // whose generated files have drifted from the contract. `runAllStages` will
  // also halt after the generated stage, but doing the guard here avoids the
  // side effects in `collectProtectedCheckState`.
  if (!context.generated.ok) {
    const reports = await runAllStages(context, makeEmptyProtectedState(context), "check", options, filters);
    const report = mergeCheckReports(reports);
    await recordViolationEvent(projectDir, report);
    await persistLastReport(projectDir, report);
    throw new CheckCommandError(getCheckExitCode(report), report);
  }

  const protectedState = await collectProtectedCheckState(projectDir, context.config, context.contract, context.generated);
  const reports = await runAllStages(context, protectedState, "check", options, filters);
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

export async function prepareCheckContext(projectDir: string, changedFileSet?: Set<string>): Promise<PreparedCheckContext> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  return prepareCheckContextWithContract(projectDir, contract, changedFileSet);
}

export async function prepareCheckContextWithContract(projectDir: string, contract: Contract, changedFileSet?: Set<string>): Promise<PreparedCheckContext> {
  const config = await loadConfig(projectDir);
  const backend = await loadBackend(config.targetLanguage, config.testFramework);
  const generated = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  return {
    projectDir,
    config,
    contract,
    generated,
    invariantCount: contract.invariants.length,
    codeShapeContract: changedFileSet === undefined ? undefined : filterContractByFiles(contract, changedFileSet),
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
    contractHash: computeSha256(normalizeContract(contract)),
    summary: {
      invariantCount: contract.invariants.length,
      generatedFileCount: generated.files.length,
      protectedFileCount: toManifestPaths(projectDir, protectedPaths).length,
    },
  };
}

/**
 * Build a ProtectedCheckState placeholder for the generated-drift short-circuit
 * path. `runAllStages` halts after the generated stage when it fails, so this
 * placeholder is never inspected by downstream stages — but `runAllStages`'
 * signature still requires a typed argument.
 */
function makeEmptyProtectedState(context: PreparedCheckContext): ProtectedCheckState {
  return {
    protectedPaths: [],
    contractHash: "",
    summary: {
      invariantCount: context.invariantCount,
      generatedFileCount: context.generated.files.length,
      protectedFileCount: 0,
    },
  };
}

// ----------------------------------------------------------------
// Raw check (programmatic API)
// ----------------------------------------------------------------

export async function buildRawCheckReport(context: PreparedCheckContext, command = "check"): Promise<ViolationReport> {
  // Raw report omits baseline/diff filters — programmatic callers (baseline
  // init/update, maintenance summaries) need to see every violation, suppressed
  // or not.
  const noopFilters: ReportFilters = {};

  try {
    if (!context.generated.ok) {
      const reports = await runAllStages(context, makeEmptyProtectedState(context), command, {}, noopFilters);
      return mergeCheckReports(reports);
    }

    const protectedState = await collectProtectedCheckState(context.projectDir, context.config, context.contract, context.generated);
    const reports = await runAllStages(context, protectedState, command, {}, noopFilters);
    return mergeCheckReports(reports);
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

async function prepareCheckFilters(context: PreparedCheckContext, options: CheckCommandOptions): Promise<ReportFilters> {
  return {
    baseline: await tryReadViolationBaseline(resolve(context.projectDir, STELE_BASELINE_FILE)),
    diffScopePaths: options.diffFrom === undefined ? undefined : await collectGitDiffScope(context.projectDir, options.diffFrom),
  };
}

// ----------------------------------------------------------------
// Report building
// ----------------------------------------------------------------

function mergeCheckReports(reports: ViolationReport[]): ViolationReport {
  const rawViolations = reports.flatMap((report) => report.violations);
  // Round 3 P1-4: cross-rule annotation runs at the merged layer so a
  // trace.X.foo and effect.Y.bar firing on the same caller node now learn
  // about each other via `also_violates` + `cross_rule_note`. The function
  // is idempotent — re-annotating a per-evaluator-already-annotated set is
  // safe and produces the same fields. Only `violations` carries Violation
  // values; `notices` is `ContractNotice[]` (a different shape) and does
  // not participate in cross-rule grouping.
  const violations = annotateCrossRuleViolations(rawViolations);
  const notices = reports.flatMap((report) => report.notices);
  const activeViolations = violations.filter((violation) => (violation.status ?? "active") === "active");
  const activeViolationCount = activeViolations.length;
  const activeBlockingViolationCount = activeViolations.filter(isBlockingViolation).length;
  const suppressedViolationCount = violations.filter((violation) => violation.status === "suppressed").length;
  const outOfScopeViolationCount = violations.filter((violation) => violation.status === "out_of_scope").length;
  const lastSummary = [...reports]
    .reverse()
    .find((report) => report.summary.invariant_count !== undefined)?.summary;

  return createViolationReport({
    tool: reports[reports.length - 1]?.tool ?? "stele",
    command: reports[reports.length - 1]?.command ?? "check",
    ok: activeBlockingViolationCount === 0,
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
  const activeViolations = report.violations.filter((violation) => (violation.status ?? "active") === "active" && isBlockingViolation(violation));
  return activeViolations.length > 0 && activeViolations.every((violation) => violation.rule_kind === "generated_drift")
    ? ExitCode.CONTRACT_FAIL
    : ExitCode.TAMPER_DETECTED;
}

function isBlockingViolation(violation: Violation): boolean {
  return violation.severity !== "warning" && violation.severity !== "info";
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

  // Closeout 4: typed DESIGN_PROFILE_LIFECYCLE chain — load, then
  // unwrap through `useHashedProfile` (param 0 typed `Hashed`).
  let hashed: ReturnType<typeof loadHashedProfile>;
  try {
    hashed = loadHashedProfile(projectDir);
  } catch {
    return [];
  }
  const profile = useHashedProfile(hashed.profile);

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
    rule_id: ruleId("stele.self.no_baseline"),
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
