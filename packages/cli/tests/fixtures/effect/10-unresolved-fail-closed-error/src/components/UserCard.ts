import * as db from "../db.js";

/**
 * Dynamic dispatch: the callee `db[method]` is resolved at runtime, so
 * the call-graph extractor records an UnresolvedCall edge instead of a
 * resolved one. With strictMode=true (default) the effect evaluator
 * fails closed and emits `unresolved_call_blocks_evaluation` for any
 * scope frame that depends on the unknown effect set.
 */
export function UserCard(props: { id: string; method: string }): string {
  const dispatch = db as unknown as Record<string, (id: string) => { name: string }>;
  const fn = dispatch[props.method];
  if (fn === undefined) return "<div>?</div>";
  const u = fn(props.id);
  return `<div>${u.name}</div>`;
}
