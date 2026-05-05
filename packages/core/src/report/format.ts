import type { Violation, ViolationReport } from "./types.js";

export function formatViolationReportHuman(report: ViolationReport): string {
  if (report.ok) {
    return `${report.summary.message ?? "OK"}\n`;
  }

  return `${report.violations.map(formatViolationHuman).join("\n")}\n`;
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
