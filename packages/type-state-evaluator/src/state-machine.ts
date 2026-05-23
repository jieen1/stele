/**
 * State-machine graph helpers. Operate on `TypeStateDeclaration` shapes and
 * answer the three questions the evaluator needs at every call site:
 *
 *   1. Does `method` legitimately transition out of `state`? (transition edge)
 *   2. Is `method` an allowed non-transition operation in `state`? (allowed-ops)
 *   3. Are there any unreachable states? (warning surface for future use)
 *
 * Pure functions — no IO, no mutation of inputs.
 */

import type { TypeStateDeclaration } from "@stele/core";

/**
 * `true` iff `method` is the `via` of a transition whose `from` includes
 * `fromState`.
 */
export function methodIsTransition(
  decl: TypeStateDeclaration,
  fromState: string,
  method: string,
): boolean {
  for (const transition of decl.transitions) {
    if (transition.via !== method) {
      continue;
    }
    for (const src of transition.from) {
      if (src === fromState) {
        return true;
      }
    }
  }
  return false;
}

/**
 * If `method` legitimately transitions out of `fromState`, return the
 * destination state. Otherwise `null`.
 *
 * When two transitions share `from`+`via` (illegal at the validator layer
 * but defensively handled here), the first match wins for determinism.
 */
export function methodTransitionsTo(
  decl: TypeStateDeclaration,
  fromState: string,
  method: string,
): string | null {
  for (const transition of decl.transitions) {
    if (transition.via !== method) {
      continue;
    }
    for (const src of transition.from) {
      if (src === fromState) {
        return transition.to;
      }
    }
  }
  return null;
}

/**
 * `true` iff `method` is explicitly listed in `(allowed-ops <state> ...)`.
 *
 * Transitions out of `state` are NOT automatically allowed-ops — the
 * evaluator checks transitions and allowed-ops separately. This function
 * answers ONLY the explicit allow list.
 */
export function methodIsAllowedOp(
  decl: TypeStateDeclaration,
  state: string,
  method: string,
): boolean {
  const allowed = decl.allowedOps.get(state);
  if (allowed === undefined) {
    return false;
  }
  for (const op of allowed) {
    if (op === method) {
      return true;
    }
  }
  return false;
}

/** `true` iff `state` is declared in `(terminal ...)`. */
export function isTerminal(decl: TypeStateDeclaration, state: string): boolean {
  for (const t of decl.terminal) {
    if (t === state) {
      return true;
    }
  }
  return false;
}

/**
 * Every state reachable from `decl.initial` via the declared transitions
 * (BFS from initial). Always includes `initial` itself.
 *
 * Useful for surfacing unreachable-state warnings to contract authors and
 * for guarding empty allowed-ops checks (an unreachable state still counts
 * as a declared state for legitimate-op lookups, even if the call graph
 * could never witness it).
 */
export function reachableStates(decl: TypeStateDeclaration): ReadonlySet<string> {
  const reached = new Set<string>([decl.initial]);
  const stack: string[] = [decl.initial];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const transition of decl.transitions) {
      if (!transition.from.includes(current)) {
        continue;
      }
      if (!reached.has(transition.to)) {
        reached.add(transition.to);
        stack.push(transition.to);
      }
    }
  }
  return reached;
}

/**
 * States in `decl.states` that are NOT reachable from `decl.initial`. Useful
 * for advisory diagnostics (not yet emitted as violations in B.1).
 */
export function unreachableStates(decl: TypeStateDeclaration): readonly string[] {
  const reached = reachableStates(decl);
  const out: string[] = [];
  for (const s of decl.states) {
    if (!reached.has(s)) {
      out.push(s);
    }
  }
  return Object.freeze(out);
}
