import * as db from "../db.js";

/**
 * Dynamic dispatch: the callee `db[method]` is resolved at runtime, so
 * the call-graph extractor records an UnresolvedCall edge instead of a
 * resolved one. When the caller node sits inside an active effect-policy's
 * target-scope (Closeout 1, 2026-05-25) the effect evaluator fails closed
 * and emits `unresolved_call_blocks_evaluation`. Out-of-scope unresolved
 * calls emit nothing — no policy cares.
 */
export function UserCard(props: { id: string; method: string }): string {
  const dispatch = db as unknown as Record<string, (id: string) => { name: string }>;
  const fn = dispatch[props.method];
  if (fn === undefined) return "<div>?</div>";
  const u = fn(props.id);
  return `<div>${u.name}</div>`;
}
