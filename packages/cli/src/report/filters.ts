import {
  filterViolationReport,
  type Violation,
  type ViolationBaseline,
  type ViolationReport,
} from "@stele/core";
import { STELE_BASELINE_FILE } from "../config/defaults.js";

export type ReportFilters = {
  baseline?: ViolationBaseline;
  diffScopePaths?: string[];
};

/**
 * Apply baseline + diff-scope filters to a ViolationReport.
 *
 * Canonical implementation used by both `runAllStages` (registry runner) and
 * the programmatic check API in `commands/check.ts`. There is exactly one copy
 * of this logic — do not reintroduce a private duplicate in check.ts.
 */
export function applyFiltersToReport(report: ViolationReport, filters: ReportFilters): ViolationReport {
  return filterViolationReport(report, {
    baseline: report.violations.some((violation) => violation.scope_paths.includes(STELE_BASELINE_FILE)) ? undefined : filters.baseline,
    diffScopePaths: filters.diffScopePaths,
    isSuppressible: isCheckSuppressibleViolation,
  });
}

/**
 * Whether a violation may be suppressed by a baseline entry. A violation is
 * suppressible iff it is baseline-eligible AND has at least one scope path.
 */
function isCheckSuppressibleViolation(violation: Violation): boolean {
  return isBaselineEligibleViolation(violation) && violation.scope_paths.length > 0;
}

/**
 * Whether a violation is eligible to appear in a Stele baseline file.
 *
 * Re-exported from `commands/check.ts` for backward compatibility with
 * callers (baseline.ts, tests) that import it from the check module.
 */
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
