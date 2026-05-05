import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import {
  createViolation,
  createViolationReport,
  filterViolationReport,
  formatViolationReportHuman,
  formatViolationReportJson,
  loadContract,
  normalizeContract,
  tryReadViolationBaseline,
  verifyManifest,
  type Contract,
  type GeneratedVerificationResult,
  type VerificationResult,
  type Violation,
  type ViolationBaseline,
  type ViolationReport,
} from "@stele/core";
import { STELE_BASELINE_FILE, STELE_CONFIG_FILE, type SteleConfig } from "../config/defaults.js";
import { loadConfig } from "../config/loadConfig.js";
import { evaluateCodeShapes } from "../code-shape/evaluate.js";
import { CliCommandError } from "../errors.js";
import {
  assertProtectedContractFilesReachable,
  collectProtectedPaths,
  createLanguageBackend,
  sha256,
  toManifestPaths,
  verifyManagedGeneratedFiles,
} from "./generate.js";

const execFileAsync = promisify(execFile);

export type CheckSummary = {
  invariantCount: number;
  generatedFileCount: number;
  protectedFileCount: number;
};

export type CheckCommandOptions = {
  diffFrom?: string;
  json?: boolean;
  reportFile?: string;
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

export async function runCheck(projectDir: string, options: CheckCommandOptions = {}): Promise<void> {
  await checkProject(projectDir, options);
}

export async function checkProject(projectDir: string, options: CheckCommandOptions = {}): Promise<CheckCommandResult> {
  const context = await prepareCheckContext(projectDir);
  const filters = await prepareCheckFilters(context, options);
  const generatedReport = applyFiltersToReport(buildGeneratedStageReport(context, "check"), filters);

  if (!generatedReport.ok) {
    throw new CheckCommandError(getCheckExitCode(generatedReport), generatedReport);
  }

  const protectedState = await collectProtectedCheckState(projectDir, context.config, context.contract, context.generated);
  const protectedReport = applyFiltersToReport(await buildProtectedStageReport(context, protectedState, "check"), filters);
  const codeShapeReport = applyFiltersToReport(await buildCodeShapeStageReport(context, protectedState, "check"), filters);
  const report = mergeCheckReports([generatedReport, protectedReport, codeShapeReport]);

  if (!report.ok) {
    throw new CheckCommandError(getCheckExitCode(report), report);
  }

  return {
    summary: protectedState.summary,
    report: withCheckSummary(report, protectedState.summary),
  };
}

export async function prepareCheckContext(projectDir: string): Promise<PreparedCheckContext> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const backend = createLanguageBackend(config.generatedDir, config.targetLanguage, config.testFramework);
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

export function formatCheckReportHuman(report: ViolationReport): string {
  return formatViolationReportHuman(report);
}

export function formatCheckReportJson(report: ViolationReport): string {
  return formatViolationReportJson(report);
}

export async function writeCheckReportFile(projectDir: string, reportFile: string, report: ViolationReport): Promise<void> {
  const absoluteReportPath = resolve(projectDir, reportFile);
  await mkdir(dirname(absoluteReportPath), { recursive: true });
  await writeFile(absoluteReportPath, formatViolationReportJson(report), "utf8");
}

class CheckCommandError extends CliCommandError {
  constructor(
    exitCode: number,
    readonly report: ViolationReport,
    cause?: unknown,
  ) {
    super(formatViolationReportHuman(report).trimEnd(), exitCode, cause);
    this.name = "CheckCommandError";
  }
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

function withCheckSummary(report: ViolationReport, summary: CheckSummary): ViolationReport {
  return {
    ...report,
    ok: true,
    summary: {
      ...report.summary,
      message: formatCheckSummary(summary, report).trimEnd(),
      invariant_count: summary.invariantCount,
      generated_file_count: summary.generatedFileCount,
      protected_file_count: summary.protectedFileCount,
    },
  };
}

function getCheckExitCode(report: ViolationReport): number {
  const activeViolations = report.violations.filter((violation) => (violation.status ?? "active") === "active");
  return activeViolations.length > 0 && activeViolations.every((violation) => violation.rule_kind === "generated_drift") ? 2 : 3;
}

function isCheckSuppressibleViolation(violation: Violation): boolean {
  return isBaselineEligibleViolation(violation) && violation.scope_paths.length > 0;
}

async function collectGitDiffScope(projectDir: string, baseRef: string): Promise<string[]> {
  const repoRoot = await runGit(
    projectDir,
    ["rev-parse", "--show-toplevel"],
    `Git is required for --diff-from ${baseRef}, but no repository root was found.`,
  );
  await runGit(
    repoRoot,
    ["rev-parse", "--verify", `${baseRef}^{commit}`],
    `Git base "${baseRef}" was not found. Choose an existing branch, tag, or commit for --diff-from.`,
  );

  const outputs = await Promise.all([
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${baseRef}...HEAD`], "Unable to compute the branch diff."),
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB"], "Unable to compute unstaged diff scope."),
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", "--cached"], "Unable to compute staged diff scope."),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], "Unable to list untracked files for diff scope."),
  ]);
  const projectRoot = resolve(projectDir);
  const diffPaths = new Set<string>();

  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim();

      if (candidate.length === 0) {
        continue;
      }

      const absolutePath = resolve(repoRoot, candidate);
      const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");

      if (relativePath.length === 0 || isOutsideProject(relativePath)) {
        continue;
      }

      diffPaths.add(relativePath);
    }
  }

  return [...diffPaths].sort((left, right) => left.localeCompare(right));
}

async function runGit(cwd: string, args: string[], errorMessage: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${errorMessage} ${detail}`.trim());
  }
}

function isOutsideProject(relativePath: string): boolean {
  return relativePath.startsWith("../") || relativePath === ".." || win32.isAbsolute(relativePath);
}

function createGeneratedDriftViolation(
  entryPath: string,
  generatedDir: string,
  generated: GeneratedVerificationResult,
  command: string,
): Violation {
  return createViolation({
    rule_id: "stele.check.generated_drift",
    rule_kind: "generated_drift",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "generated",
    },
    location: {
      generated_dir: generatedDir,
    },
    cause: {
      summary: "Generated files do not match the contract.",
      missing: generated.missing,
      changed: generated.changed,
      extra: generated.extra,
    },
    scope_paths: [entryPath, ...generated.missing, ...generated.changed, ...generated.extra],
    fix: {
      summary: "Re-run stele generate --force to replace them.",
      command: "stele generate --force",
    },
  });
}

function createManifestDriftViolation(manifestPath: string, manifest: VerificationResult, command: string): Violation {
  return createViolation({
    rule_id: "stele.check.manifest_drift",
    rule_kind: "manifest_drift",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "manifest",
    },
    location: {
      manifest_path: manifestPath,
    },
    cause: {
      summary: "Manifest verification failed.",
      missing: manifest.missing,
      changed: manifest.changed,
    },
    scope_paths: [manifestPath, ...manifest.missing, ...manifest.changed],
    fix: {
      summary: "Run stele lock after approval to refresh the manifest.",
      command: "stele lock --reason <reason>",
    },
  });
}

function createProtectedFileDriftViolation(manifestPath: string, newProtectedPaths: string[], command: string): Violation {
  return createViolation({
    rule_id: "stele.check.protected_file_drift",
    rule_kind: "protected_file_drift",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "protected",
    },
    location: {
      manifest_path: manifestPath,
    },
    cause: {
      summary: "Found new/unlocked protected files.",
      new_files: newProtectedPaths,
    },
    scope_paths: [manifestPath, ...newProtectedPaths],
    fix: {
      summary: "Run stele lock after approval to capture the approved protected files.",
      command: "stele lock --reason <reason>",
    },
  });
}

function createContractHashMismatchViolation(
  entryPath: string,
  manifestPath: string,
  expectedHash: string,
  actualHash: string,
  command: string,
): Violation {
  return createViolation({
    rule_id: "stele.check.contract_hash_mismatch",
    rule_kind: "contract_hash_mismatch",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "contract",
    },
    location: {
      path: entryPath,
      manifest_path: manifestPath,
    },
    cause: {
      summary: "Manifest contract hash does not match the current contract.",
      expected_hash: expectedHash,
      actual_hash: actualHash,
    },
    scope_paths: [entryPath, manifestPath],
    fix: {
      summary: "Run stele lock after approval to capture the updated contract hash.",
      command: "stele lock --reason <reason>",
    },
  });
}

function createExecutionViolation(error: unknown, entryPath: string | undefined, command: string): Violation {
  const message = error instanceof Error ? error.message : String(error);

  return createViolation({
    rule_id: "stele.check.execution_error",
    rule_kind: "execution_error",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "execution",
    },
    location: {
      path: entryPath ?? STELE_CONFIG_FILE,
    },
    cause: {
      summary: message,
    },
    scope_paths: [entryPath ?? STELE_CONFIG_FILE],
  });
}
