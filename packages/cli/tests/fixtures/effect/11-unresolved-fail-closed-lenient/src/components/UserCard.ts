import * as db from "../db.js";

/**
 * Same dynamic-dispatch shape as fixture 10, but `.fixture-config.json`
 * sets strictMode=false. The evaluator downgrades the unresolved-call
 * blocker to an informational notice instead of a blocking violation.
 */
export function UserCard(props: { id: string; method: string }): string {
  const dispatch = db as unknown as Record<string, (id: string) => { name: string }>;
  const fn = dispatch[props.method];
  if (fn === undefined) return "<div>?</div>";
  const u = fn(props.id);
  return `<div>${u.name}</div>`;
}
