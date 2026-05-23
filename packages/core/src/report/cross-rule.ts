/**
 * Cross-rule annotation for violations sharing the same `group_id`.
 *
 * Round 3 P1-4 moves this helper from `@stele/trace-evaluator` to `@stele/core`
 * so it can be applied to the merged output of every Phase B evaluator
 * (trace / type-state / effect) — not just to the trace-evaluator's own
 * batch. The function is pure and only depends on the public `Violation`
 * schema, so core is the right home.
 *
 * Per Round 2 E-P0-1 + E-P1-2: when several rules fire on the same root
 * cause (typically the same function), the agent should see one violation
 * and learn "you also failed Y and Z when you fix X — they share a root
 * cause". After P1-4 this learning extends across evaluators:
 *   - trace.X.missing_transit + effect.Y.forbidden_effect + typestate.Z.illegal_op
 *     can all fire on the same caller node and the agent now sees them
 *     cross-referenced.
 *
 * Algorithm (pure / deterministic):
 *   1. Bucket violations by `group_id` (skip empty group_id).
 *   2. For each bucket of size ≥ 2:
 *      - For each violation in the bucket, set `also_violates` to the
 *        rule_ids of the *other* violations in that bucket
 *        (sorted, de-duplicated).
 *      - When the bucket contains ≥ 2 distinct rule_ids, attach a
 *        `cross_rule_note` warning agents to plan a unified fix.
 *
 * Idempotent: running the function twice on its own output is a no-op
 * (the second pass sees the same buckets and produces the same fields).
 *
 * The function returns NEW Violation objects; inputs are not mutated.
 */

import type { Violation } from "./types.js";

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
      return v;
    }
    return {
      ...v,
      also_violates: alsoViolates,
      cross_rule_note: CROSS_RULE_NOTE,
    };
  });
}
