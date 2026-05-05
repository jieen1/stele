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
  const lines = [
    `[${violation.severity}] ${violation.rule_id}`,
    `  source: ${violation.source.kind}/${violation.source.command}`,
    `  location: ${formatLocation(violation)}`,
    `  summary: ${violation.cause.summary}`,
  ];
  const detailLines = formatCauseDetails(violation);

  if (detailLines.length > 0) {
    lines.push(...detailLines.map((detail) => `  ${detail}`));
  }

  if (violation.fix?.summary !== undefined) {
    lines.push(`  fix: ${violation.fix.summary}`);
  }

  if (violation.fix?.command !== undefined) {
    lines.push(`  command: ${violation.fix.command}`);
  }

  lines.push(`  fingerprint: ${violation.fingerprint.slice(0, 12)}`);
  return lines.join("\n");
}

function formatPathList(paths: string[]): string {
  return paths.length === 0 ? "<none>" : paths.join(", ");
}

function formatLocation(violation: Violation): string {
  const { location } = violation;

  if (location.path !== undefined) {
    return `${location.path}${formatLineColumn(location.line, location.column)}`;
  }

  if (location.manifest_path !== undefined) {
    return `${location.manifest_path}${formatLineColumn(location.line, location.column)}`;
  }

  if (location.generated_dir !== undefined) {
    return `${location.generated_dir}${formatLineColumn(location.line, location.column)}`;
  }

  if (location.line !== undefined) {
    return `<unknown>${formatLineColumn(location.line, location.column)}`;
  }

  return "<unknown>";
}

function formatLineColumn(line?: number, column?: number): string {
  if (line === undefined) {
    return "";
  }

  if (column === undefined) {
    return `:${line}`;
  }

  return `:${line}:${column}`;
}

function formatCauseDetails(violation: Violation): string[] {
  const details: string[] = [];

  if (violation.cause.detail !== undefined) {
    details.push(`detail: ${violation.cause.detail}`);
  }

  if (violation.cause.missing !== undefined) {
    details.push(`missing: ${formatPathList(violation.cause.missing)}`);
  }

  if (violation.cause.changed !== undefined) {
    details.push(`changed: ${formatPathList(violation.cause.changed)}`);
  }

  if (violation.cause.extra !== undefined) {
    details.push(`extra: ${formatPathList(violation.cause.extra)}`);
  }

  if (violation.cause.new_files !== undefined) {
    details.push(`new_files: ${formatPathList(violation.cause.new_files)}`);
  }

  if (violation.cause.expected_hash !== undefined) {
    details.push(`expected_hash: ${violation.cause.expected_hash}`);
  }

  if (violation.cause.actual_hash !== undefined) {
    details.push(`actual_hash: ${violation.cause.actual_hash}`);
  }

  return details;
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
