import { cachedGet } from "../cache/cached-get.js";

/**
 * UserCard calls `cachedGet`, which propagates db.read upstream. The
 * contract declares `(effect-suppression ...)` at `cachedGet(1)` (with
 * a mandatory reason per Round 2 D-CG-1). Per Round 1 §five.5 the
 * evaluator deliberately surfaces the downstream NO_IO_IN_UI violation
 * AND emits `effect.suppression_active` — suppression is an audit
 * signal, not a silent chain-breaker.
 */
export function UserCard(props: { id: string }): string {
  const u = cachedGet(props.id);
  return `<div>${u.name}</div>`;
}
