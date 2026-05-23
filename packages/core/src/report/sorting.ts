import type { Violation, ViolationPriority, ViolationSeverity } from "./types.js";

/**
 * Phase B Round 2 reviewer E (E-P0-1) sort order for violations.
 *
 * Agents processing many violations need a stable order:
 *   1. priority (blocking → major → minor)
 *   2. group_id (alphabetical — same root cause stays adjacent)
 *   3. severity within group (error → warning → info / notice)
 *   4. location.path, then line, then column
 *
 * Default fallbacks keep pre-Phase-B violations sortable: priority defaults
 * to "major" and group_id defaults to "" when the field is absent.
 */

const PRIORITY_RANK: Record<ViolationPriority, number> = {
  blocking: 0,
  major: 1,
  minor: 2,
};

/**
 * Severity ranking. The shipped `ViolationSeverity` is `error | warning | info`;
 * Round 2's spec also references `"notice"` as an alias for the lowest band.
 * Both are mapped to the same rank for forward compatibility.
 *
 * Unknown severities sort after every known value (rank `99`).
 */
const SEVERITY_RANK: Record<string, number> = {
  error: 0,
  warning: 1,
  info: 2,
  notice: 2,
};

export function priorityRank(v: Violation): number {
  return PRIORITY_RANK[v.priority ?? "major"];
}

export function severityRank(v: Violation): number {
  const known = SEVERITY_RANK[v.severity as ViolationSeverity];
  return known ?? 99;
}

export function compareViolationsByPriority(a: Violation, b: Violation): number {
  // priority asc by rank (blocking=0 first)
  const dp = priorityRank(a) - priorityRank(b);
  if (dp !== 0) return dp;

  // group_id ascending
  const ga = a.group_id ?? "";
  const gb = b.group_id ?? "";
  if (ga !== gb) return ga < gb ? -1 : 1;

  // severity within group
  const ds = severityRank(a) - severityRank(b);
  if (ds !== 0) return ds;

  // location
  const pa = a.location?.path ?? "";
  const pb = b.location?.path ?? "";
  if (pa !== pb) return pa < pb ? -1 : 1;

  const la = a.location?.line ?? 0;
  const lb = b.location?.line ?? 0;
  if (la !== lb) return la - lb;

  return (a.location?.column ?? 0) - (b.location?.column ?? 0);
}

/**
 * Pure, non-mutating sort: returns a new array. Use when surfacing
 * many violations to an agent so blocking issues come first.
 */
export function sortViolations(violations: readonly Violation[]): Violation[] {
  return [...violations].sort(compareViolationsByPriority);
}
