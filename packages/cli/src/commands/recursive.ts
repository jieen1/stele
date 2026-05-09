import type { ViolationReport } from "@stele/core";

/**
 * Per-project sub-report captured by a recursive command run.
 *
 * `exit_code` follows {@link ./errors.ExitCode}. `violations` is included when
 * the underlying single-project run produced a `ViolationReport` (i.e. for
 * `check`).
 */
export type SubReport = {
  project: string;
  exit_code: number;
  summary: {
    invariant_count?: number;
    violation_count?: number;
    generated_file_count?: number;
    protected_file_count?: number;
    [key: string]: unknown;
  };
  violations?: ViolationReport["violations"];
  error?: {
    message: string;
    code?: string;
  };
};

/**
 * Aggregate per-project exit codes into a single CLI exit code.
 *
 * Priority (per docs/design/phase-1/08-recursive-flag.md §5):
 *  - Any project exit 1 (user/internal error) → 1.
 *  - Otherwise, max(exit codes of remaining 2/3 results).
 *  - Otherwise, 0.
 *
 * Rationale: hide drift (2/3) behind hard errors (1) so CI does not
 * mis-classify config/parse failures as "recoverable drift".
 */
export function aggregateExitCode(subReports: ReadonlyArray<SubReport>): number {
  if (subReports.some((report) => report.exit_code === 1)) {
    return 1;
  }

  const drift = subReports.filter((report) => report.exit_code === 2 || report.exit_code === 3);

  if (drift.length === 0) {
    // If there are no exit-2/3 results but some non-zero exit code (e.g. 4 for
    // GENERATION_FAIL, 5 for CONFIG_ERROR), surface the maximum so the caller
    // still observes a failure signal.
    const nonZero = subReports.filter((report) => report.exit_code !== 0);
    return nonZero.length === 0 ? 0 : Math.max(...nonZero.map((report) => report.exit_code));
  }

  return Math.max(...drift.map((report) => report.exit_code));
}

/**
 * Format the per-project header used at the start of a recursive run.
 */
export function formatRecursiveHeader(projects: ReadonlyArray<string>): string {
  const lines = [`Found ${projects.length} project${projects.length === 1 ? "" : "s"}:`];

  for (let i = 0; i < projects.length; i++) {
    lines.push(`  [${i + 1}/${projects.length}] ${projects[i]}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format the summary footer printed after every project has been processed.
 */
export function formatRecursiveSummary(subReports: ReadonlyArray<SubReport>): string {
  const passed = subReports.filter((report) => report.exit_code === 0).length;
  const failed = subReports.length - passed;
  return `Summary: ${passed}/${subReports.length} passed; ${failed}/${subReports.length} failed.\n`;
}
