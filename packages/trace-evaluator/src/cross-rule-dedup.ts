/**
 * Cross-rule annotation for violations sharing the same `group_id`.
 *
 * Per Round 2 E-P0-1 + E-P1-2: when several rules fire on the same root cause
 * (typically the same function), the agent should see one violation and learn
 * "you also failed Y and Z when you fix X — they share a root cause".
 *
 * Algorithm (pure / deterministic):
 *   1. Bucket violations by `group_id` (skip empty group_id).
 *   2. For each bucket of size ≥ 2:
 *      - For each violation in the bucket, set `also_violates` to the rule_ids
 *        of the *other* violations in that bucket (sorted, de-duplicated).
 *      - When the bucket contains ≥ 2 distinct rule_ids, attach a
 *        `cross_rule_note` warning agents to plan a unified fix.
 *
 * The function returns NEW Violation objects; inputs are not mutated.
 */

import type { Violation } from "@stele/core";

const CROSS_RULE_NOTE =
  "Multiple rules flag this function — plan a fix that satisfies all rule_ids listed in also_violates simultaneously.";

function uniqueSortedExcluding(
  ruleIds: readonly string[],
  exclude: string,
): readonly string[] {
  const seen = new Set<string>();
  for (const id of ruleIds) {
    if (id === exclude) {
      continue;
    }
    seen.add(id);
  }
  return Object.freeze(
    [...seen].sort((a, b) => a.localeCompare(b)),
  );
}

export function annotateCrossRuleViolations(
  violations: readonly Violation[],
): Violation[] {
  if (violations.length === 0) {
    return [];
  }
  // Bucket by group_id.
  const buckets = new Map<string, Violation[]>();
  for (const v of violations) {
    const g = v.group_id;
    if (g === undefined || g.length === 0) {
      continue;
    }
    let bucket = buckets.get(g);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(g, bucket);
    }
    bucket.push(v);
  }

  return violations.map((v) => {
    const g = v.group_id;
    if (g === undefined || g.length === 0) {
      return v;
    }
    const bucket = buckets.get(g);
    if (bucket === undefined || bucket.length < 2) {
      return v;
    }
    const ruleIds = bucket.map((b) => b.rule_id);
    const alsoViolates = uniqueSortedExcluding(ruleIds, v.rule_id);
    if (alsoViolates.length === 0) {
      // Bucket of duplicates of the same rule_id — no cross-rule reference.
      return v;
    }
    return {
      ...v,
      also_violates: alsoViolates,
      cross_rule_note: CROSS_RULE_NOTE,
    };
  });
}
