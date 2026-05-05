import type { Violation, ViolationReport } from "./types.js";

export function formatViolationReportHuman(report: ViolationReport): string {
  const activeViolations = report.violations.filter((violation) => (violation.status ?? "active") === "active");

  if (report.ok) {
    return `${report.summary.message ?? "OK"}\n`;
  }

  const lines = activeViolations.map(formatViolationHuman);
  const suppressionSummary = formatSuppressionSummary(report);

  if (suppressionSummary !== undefined) {
    lines.push(suppressionSummary);
  }

  return `${lines.join("\n")}\n`;
}

export function formatViolationReportJson(report: ViolationReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function formatViolationHuman(violation: Violation): string {
  const segments = [violation.cause.summary];

  if (violation.cause.missing !== undefined) {
    segments.push(`Missing: ${formatPathList(violation.cause.missing)}.`);
  }

  if (violation.cause.changed !== undefined) {
    segments.push(`Changed: ${formatPathList(violation.cause.changed)}.`);
  }

  if (violation.cause.extra !== undefined) {
    segments.push(`Extra: ${formatPathList(violation.cause.extra)}.`);
  }

  if (violation.cause.new_files !== undefined) {
    segments.push(`Files: ${formatPathList(violation.cause.new_files)}.`);
  }

  if (violation.fix?.summary !== undefined) {
    segments.push(violation.fix.summary);
  }

  return segments.join(" ");
}

function formatPathList(paths: string[]): string {
  return paths.length === 0 ? "<none>" : paths.join(", ");
}

function formatSuppressionSummary(report: ViolationReport): string | undefined {
  const fragments: string[] = [];
  const suppressedCount = report.summary.suppressed_violation_count ?? 0;
  const outOfScopeCount = report.summary.out_of_scope_violation_count ?? 0;

  if (suppressedCount > 0) {
    fragments.push(`${suppressedCount} baseline violation${suppressedCount === 1 ? "" : "s"} suppressed.`);
  }

  if (outOfScopeCount > 0) {
    fragments.push(`${outOfScopeCount} out-of-scope violation${outOfScopeCount === 1 ? "" : "s"} ignored.`);
  }

  return fragments.length === 0 ? undefined : fragments.join(" ");
}
