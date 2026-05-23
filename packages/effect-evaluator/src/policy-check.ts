/**
 * Effect policy checking. Given an EffectPolicyDeclaration, the effective
 * effect set per node, and the call graph node universe, compute the
 * `(node, offendingEffect)` pairs that need a violation.
 *
 *   - `forbid` policies: a violation per (node, effect) where effect is
 *     reachable AND effect is in the forbidden set.
 *   - `allow-only` policies: a violation per (node, effect) where effect
 *     is reachable AND effect is NOT in the allow-only set.
 *
 * Effect refs in both lists are glob-aware: `payment.*` matches
 * `payment.charge` and `payment.refund`. Glob expansion uses the project's
 * declared effect names — see `effect-set.ts::expandEffectPatterns`.
 *
 * Scope matching reuses `@stele/call-graph-core`'s pattern matcher so the
 * policy's `target-scope` patterns share semantics with other Phase B
 * scopes (full NodeId globs, extern: support).
 */

import { compilePattern, type CompiledPattern } from "@stele/call-graph-core";
import type { CallGraph, CallGraphNode } from "@stele/call-graph-core";
import type { EffectPolicyDeclaration } from "@stele/core";

import { expandEffectPatterns } from "./effect-set.js";

export interface PolicyMatch {
  readonly node: CallGraphNode;
  readonly offendingEffect: string;
  readonly directOnNode: boolean;
}

export interface CheckForbidOptions {
  readonly policy: EffectPolicyDeclaration;
  readonly callGraph: CallGraph;
  readonly effectiveByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly directByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly declaredEffects: ReadonlySet<string>;
}

/**
 * Returns the set of (node, offendingEffect) tuples violating a `forbid`
 * policy. Ordering is deterministic: scope nodes ordered by NodeId, effects
 * within each node ordered lexicographically.
 */
export function checkForbid(options: CheckForbidOptions): readonly PolicyMatch[] {
  const { policy, callGraph, effectiveByNode, directByNode, declaredEffects } = options;
  if (policy.forbid === undefined || policy.forbid.length === 0) {
    return Object.freeze([]);
  }
  const forbidden = expandEffectPatterns(policy.forbid, declaredEffects);
  if (forbidden.size === 0) {
    return Object.freeze([]);
  }
  return collectMatches({
    policy,
    callGraph,
    effectiveByNode,
    directByNode,
    test: (effect) => forbidden.has(effect),
  });
}

export interface CheckAllowOnlyOptions {
  readonly policy: EffectPolicyDeclaration;
  readonly callGraph: CallGraph;
  readonly effectiveByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly directByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly declaredEffects: ReadonlySet<string>;
}

/**
 * Returns the set of (node, offendingEffect) tuples violating an
 * `allow-only` policy. An empty allow list means "nothing allowed" — any
 * reachable effect produces a violation (matches REDUCERS_PURE example in
 * the spec).
 */
export function checkAllowOnly(options: CheckAllowOnlyOptions): readonly PolicyMatch[] {
  const { policy, callGraph, effectiveByNode, directByNode, declaredEffects } = options;
  if (policy.allowOnly === undefined) {
    return Object.freeze([]);
  }
  const allowed = expandEffectPatterns(policy.allowOnly, declaredEffects);
  return collectMatches({
    policy,
    callGraph,
    effectiveByNode,
    directByNode,
    test: (effect) => !allowed.has(effect),
  });
}

interface CollectOptions {
  readonly policy: EffectPolicyDeclaration;
  readonly callGraph: CallGraph;
  readonly effectiveByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly directByNode: ReadonlyMap<string, ReadonlySet<string>>;
  readonly test: (effect: string) => boolean;
}

function collectMatches(options: CollectOptions): readonly PolicyMatch[] {
  const { policy, callGraph, effectiveByNode, directByNode, test } = options;
  const scopePatterns = compileScope(policy.targetScope);
  const matches: PolicyMatch[] = [];

  // Deterministic node iteration order.
  const nodes = [...callGraph.nodes].sort((a, b) => a.id.localeCompare(b.id));

  for (const node of nodes) {
    if (!matchAny(node.id, scopePatterns)) {
      continue;
    }
    const effective = effectiveByNode.get(node.id);
    if (effective === undefined || effective.size === 0) {
      continue;
    }
    const direct = directByNode.get(node.id) ?? new Set<string>();
    const offending: string[] = [];
    for (const e of effective) {
      if (test(e)) {
        offending.push(e);
      }
    }
    offending.sort((a, b) => a.localeCompare(b));
    for (const e of offending) {
      matches.push({
        node,
        offendingEffect: e,
        directOnNode: direct.has(e),
      });
    }
  }
  return Object.freeze(matches);
}

function compileScope(patterns: readonly string[]): readonly CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (const p of patterns) {
    out.push(compilePattern(p));
  }
  return out;
}

function matchAny(nodeId: string, patterns: readonly CompiledPattern[]): boolean {
  for (const p of patterns) {
    if (p.matches(nodeId)) {
      return true;
    }
  }
  return false;
}

/**
 * Return the unique set of node IDs in `callGraph` whose NodeId matches any
 * of the given scope patterns. Exposed for downstream `notices` (e.g.
 * "scope matched 0 nodes — policy dormant").
 */
export function resolveScopeNodes(
  callGraph: CallGraph,
  scopePatterns: readonly string[],
): readonly string[] {
  const compiled = compileScope(scopePatterns);
  const ids: string[] = [];
  for (const n of callGraph.nodes) {
    if (matchAny(n.id, compiled)) {
      ids.push(n.id);
    }
  }
  ids.sort((a, b) => a.localeCompare(b));
  return Object.freeze(ids);
}
