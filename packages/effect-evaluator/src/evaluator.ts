/**
 * Effect evaluator. Top-level entry point — turns
 *   `contract.effectDeclarations` +
 *   `contract.effectAnnotations` +
 *   `contract.effectPolicies` +
 *   `contract.effectSuppressions` +
 *   a `CallGraph` +
 *   a per-backend `EffectAnnotationExtractor`
 * into deterministic `Violation[]` + advisory `notices[]`.
 *
 * Algorithm (per docs/design/phase-b/04-effect-system.md §five):
 *
 *   1. Build the project's declared-effect name table.
 *   2. Initialise per-node effect set from CDL annotations + source-code
 *      annotations (extractor result merged onto CallGraphNode.effects).
 *   3. Apply CDL suppressions to the INITIAL set (Round 1 spec).
 *   4. Worklist + reverse-postorder propagation (Round 2 MC-7).
 *   5. For each unresolved call in the graph whose caller node sits inside
 *      at least one active policy's `target-scope`: emit a fail-closed
 *      violation `effect.unresolved_call_blocks_evaluation` (always
 *      severity=error — Round 2 D-CG-5) AND opaquely include all declared
 *      effects on the offending node's effective set. Unresolved calls in
 *      out-of-scope nodes emit nothing: no policy cares, so there is
 *      nothing to fail closed on. Closeout 1 (2026-05-25) replaces the
 *      prior globally-unconditional strictMode behaviour with this
 *      per-policy gate.
 *   6. For each effect-policy: walk scope nodes and emit violations for
 *      forbid/allow-only mismatches.
 *
 * Per Round 2 MC-15 every emitted violation carries an A/B-branched
 * fix-hint (see fix-hint.ts).
 */

import {
  compilePattern,
  resolveExternPattern,
  type CompiledPattern,
  type ExternAliasRegistry,
} from "@stele/call-graph-core";
import type { CallGraph, CallGraphNode } from "@stele/call-graph-core";
import {
  stableStringCompare,
  type Contract,
  type EffectAnnotationDeclaration,
  type Violation,
} from "@stele/core";

import { expandEffectPatterns, sortedSet, unionEffects } from "./effect-set.js";
import {
  buildPropagationChain,
  propagateEffects,
  type PropagationResult,
} from "./propagation.js";
import { checkAllowOnly, checkForbid, type PolicyMatch } from "./policy-check.js";
import { applySuppressions } from "./suppression.js";
import type { EffectAnnotationExtractor } from "./trait.js";
import type { PropagationEvidence } from "./types.js";
import {
  buildDisallowedEffectViolation,
  buildForbiddenEffectViolation,
  buildUnresolvedCallViolation,
} from "./violation-builder.js";

export interface EvaluateEffectOptions {
  readonly contract: Contract;
  readonly callGraph: CallGraph;
  readonly extractor: EffectAnnotationExtractor;
  /**
   * Round 4 D-07: cross-language alias registry built from
   * `(extern-alias ...)` declarations in the contract. When present, any
   * `extern:<logical-name>::...` pattern in an effect policy's scope or
   * an annotation target is resolved through this registry before being
   * matched against the call graph. Without the registry these patterns
   * fall through to literal matching, which never resolves cross-language.
   */
  readonly externAliases?: ExternAliasRegistry;
}

export interface EvaluateEffectStats {
  readonly policiesEvaluated: number;
  readonly nodesAnalyzed: number;
  readonly unresolvedFailures: number;
  readonly propagationRounds: number;
  readonly suppressionsActive: number;
}

/** Per-policy binding coverage — drives the zero-binding guard. */
export interface EffectPolicyCoverage {
  readonly policyId: string;
  readonly severity: string;
  readonly scopeNodesMatched: number;
}

export interface EvaluateEffectResult {
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
  readonly stats: EvaluateEffectStats;
  readonly coverage: readonly EffectPolicyCoverage[];
}

function flattenDeclaredEffects(contract: Contract): ReadonlySet<string> {
  const names: string[] = [];
  for (const block of contract.effectDeclarations) {
    for (const e of block.effects) {
      names.push(e.name);
    }
  }
  return sortedSet(names);
}

function compileAnnotationTargets(
  annotation: EffectAnnotationDeclaration,
  callGraphLanguage: CallGraph["language"],
  externAliases: ExternAliasRegistry | undefined,
): readonly CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (const raw of annotation.target) {
    let pattern = raw;
    if (externAliases !== undefined) {
      const resolved = resolveExternPattern(pattern, callGraphLanguage, externAliases);
      if (resolved !== null) {
        pattern = resolved;
      }
    }
    out.push(compilePattern(pattern));
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

function buildInitialEffects(
  contract: Contract,
  callGraph: CallGraph,
  annotationsByNode: ReadonlyMap<string, readonly string[]>,
  externAliases: ExternAliasRegistry | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  // Pre-compile annotation patterns once. Round 4 D-07: extern-alias
  // resolution happens at compile time so `extern:logical-name::Sym`
  // targets are rewritten into the call-graph's actual language form.
  const compiledAnnotations = contract.effectAnnotations.map((a) => ({
    annotation: a,
    patterns: compileAnnotationTargets(a, callGraph.language, externAliases),
  }));

  for (const node of callGraph.nodes) {
    const initial = new Set<string>();
    // (a) CDL annotation patterns
    for (const { annotation, patterns } of compiledAnnotations) {
      if (matchAny(node.id, patterns)) {
        for (const e of annotation.annotates) {
          initial.add(e);
        }
      }
    }
    // (b) Source-code annotations from the extractor.
    const annot = annotationsByNode.get(node.id);
    if (annot !== undefined) {
      for (const e of annot) {
        initial.add(e);
      }
    }
    // (c) CallGraphNode.effects (some backends pre-fill this).
    if (node.effects !== undefined) {
      for (const e of node.effects) {
        initial.add(e);
      }
    }
    if (initial.size === 0) {
      out.set(node.id, Object.freeze(new Set<string>()));
    } else {
      const frozen = sortedSet(initial);
      out.set(node.id, frozen);
    }
  }
  return out;
}

function nodesById(callGraph: CallGraph): ReadonlyMap<string, CallGraphNode> {
  const out = new Map<string, CallGraphNode>();
  for (const n of callGraph.nodes) {
    out.set(n.id, n);
  }
  return out;
}

/**
 * Set of NodeIds the author has explicitly annotated with an effect set
 * (either via JSDoc `@stele:effects ...` in source, or via a CDL
 * `(effect-annotation ...)` declaration). Closeout 1 Category B
 * (2026-05-25): these nodes are treated as closed-world — the author's
 * declaration overrides analyzer uncertainty about unresolved callees.
 *
 * An empty annotation list (an `@stele:effects` tag with no names) also
 * counts: it is a deliberate declaration that the node performs zero
 * effects, which is itself information the analyzer could not have
 * inferred from an unresolved call.
 */
function collectNodesWithDeclaredEffects(
  contract: Contract,
  callGraph: CallGraph,
  annotationsByNode: ReadonlyMap<string, readonly string[]>,
  externAliases: ExternAliasRegistry | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  // Source-level annotations from the extractor.
  for (const nodeId of annotationsByNode.keys()) {
    out.add(nodeId);
  }
  // CDL `(effect-annotation ...)` declarations.
  const compiledAnnotations = contract.effectAnnotations.map((a) => ({
    annotation: a,
    patterns: compileAnnotationTargets(a, callGraph.language, externAliases),
  }));
  for (const node of callGraph.nodes) {
    if (out.has(node.id)) continue;
    for (const { patterns } of compiledAnnotations) {
      if (matchAny(node.id, patterns)) {
        out.add(node.id);
        break;
      }
    }
  }
  return out;
}

function buildEvidence(
  propagation: PropagationResult,
  match: PolicyMatch,
  callGraph: CallGraph,
): PropagationEvidence {
  const direct = propagation.directByNode.get(match.node.id) ?? new Set<string>();
  const inherited = propagation.inheritedByNode.get(match.node.id) ?? new Set<string>();
  const rootsPerEffect = propagation.propagationRoots.get(match.node.id);
  const rootList = rootsPerEffect?.get(match.offendingEffect) ?? [];

  const chain = buildPropagationChain(
    callGraph,
    match.node.id,
    match.offendingEffect,
    propagation.effectiveByNode,
    propagation.directByNode,
  );

  return {
    offendingEffect: match.offendingEffect,
    directEffectsOnNode: [...direct].sort((a, b) => stableStringCompare(a, b)),
    inheritedEffects: [...inherited].sort((a, b) => stableStringCompare(a, b)),
    propagationRootNodes: [...rootList].sort((a, b) => stableStringCompare(a, b)),
    propagationChain: chain,
  };
}

/**
 * Apply Round 2 D-CG-5: widen every IN-SCOPE unresolved-call node's
 * effective set to include all declared effects. Returns a NEW effective
 * map (input is unchanged).
 *
 * Closeout 1 (2026-05-25): only unresolved-call sites whose caller node
 * sits inside at least one active policy's `target-scope` are widened
 * (and emitted). Out-of-scope sites are invisible — no policy cares.
 * `inScopeUnresolvedNodes` is the gating set computed by the caller.
 */
function applyUnresolvedFailClosed(
  effectiveByNode: ReadonlyMap<string, ReadonlySet<string>>,
  declaredEffects: ReadonlySet<string>,
  inScopeUnresolvedNodes: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (inScopeUnresolvedNodes.size === 0 || declaredEffects.size === 0) {
    return effectiveByNode;
  }
  const out = new Map<string, ReadonlySet<string>>(effectiveByNode);
  for (const id of inScopeUnresolvedNodes) {
    const previous = out.get(id) ?? new Set<string>();
    out.set(id, unionEffects(previous, declaredEffects));
  }
  return out;
}

export async function evaluateEffects(
  options: EvaluateEffectOptions,
): Promise<EvaluateEffectResult> {
  const { contract, callGraph, extractor, externAliases } = options;

  // Step 1 — declared effect name table.
  const declaredEffects = flattenDeclaredEffects(contract);

  // Closeout 1 (2026-05-25) — pre-compile every active policy's target-scope
  // patterns once per evaluator run. The same compiled patterns gate
  // unresolved-call emission (step 6 below) so per-policy fail-closed
  // semantics replace the old globally-unconditional strictMode behaviour.
  // Out-of-scope nodes simply emit nothing: no policy cares.
  const activeScopeMatchers: CompiledPattern[] = [];
  const coverage: EffectPolicyCoverage[] = [];
  for (const policy of contract.effectPolicies) {
    const policyMatchers: CompiledPattern[] = [];
    for (const raw of policy.targetScope) {
      let pattern = raw;
      if (externAliases !== undefined) {
        const resolved = resolveExternPattern(
          pattern,
          callGraph.language,
          externAliases,
        );
        if (resolved !== null) {
          pattern = resolved;
        }
      }
      const compiled = compilePattern(pattern);
      policyMatchers.push(compiled);
      activeScopeMatchers.push(compiled);
    }
    // Per-policy coverage: how many call-graph nodes this policy's target-scope
    // actually binds. Drives the zero-binding guard in the effect check stage —
    // a renamed file / mistyped glob that resolves to 0 nodes must FAIL, not
    // pass green (symmetric with the trace + type-state guards).
    let scopeNodesMatched = 0;
    for (const n of callGraph.nodes) {
      if (matchAny(n.id, policyMatchers)) {
        scopeNodesMatched += 1;
      }
    }
    coverage.push({
      policyId: policy.id,
      severity: policy.severity,
      scopeNodesMatched,
    });
  }

  // Step 2 — read source-code annotations.
  const extracted = await extractor.extractAnnotations({
    callGraph,
    projectRoot: callGraph.projectRoot,
  });
  // Step 3 — initial direct effects per node.
  const initialEffects = buildInitialEffects(
    contract,
    callGraph,
    extracted.annotationsByNode,
    externAliases,
  );

  // Step 4 — apply CDL suppressions.
  const callGraphNodeIds = new Set<string>();
  for (const n of callGraph.nodes) {
    callGraphNodeIds.add(n.id);
  }
  const suppressionResult = applySuppressions({
    initialEffectsByNode: initialEffects,
    suppressions: contract.effectSuppressions,
    declaredEffects,
    callGraphNodeIds,
  });

  // Step 5 — worklist propagation. Suppressions removed the effect from
  // the target node's INITIAL set (already done by applySuppressions
  // above). They deliberately do NOT block effect propagation FROM the
  // suppressed node to its callers — Round 1 § five.5 requires the
  // downstream policy violation to remain visible so suppression cannot
  // silently mask cross-scope leakage; the `effect.suppression_active`
  // notice is the audit trail.
  const propagation = propagateEffects({
    callGraph,
    initialEffectsByNode: suppressionResult.initialEffectsByNode,
  });

  // Step 6 — D-CG-5 fail-closed gating (Closeout 1, 2026-05-25). Compute
  // the set of unresolved-call caller nodes that fall inside at least one
  // active policy's target-scope. Out-of-scope caller nodes emit nothing
  // because no policy cares — the principled replacement for the prior
  // global strictMode knob (which silenced everything indiscriminately).
  //
  // Additional gate (Closeout 1 Category B, 2026-05-25): a node that
  // carries an explicit source-level effect annotation (`@stele:effects
  // ...`) OR matches a CDL `(effect-annotation ...)` is treated as
  // closed-world — the author has attested to the complete effect set,
  // overriding the analyzer's "I cannot resolve this callee" uncertainty.
  // Such nodes do NOT emit `unresolved_call_blocks_evaluation`, and the
  // fail-closed widening does not apply (the declared effects already
  // sit in `initialEffects`; widening to ALL declared effects would
  // falsely accuse the node of effects the author has explicitly
  // disclaimed). If the author lies, downstream policy checks still fire
  // against the declared set, and ordinary code review catches the lie.
  const nodeIndex = nodesById(callGraph);
  const nodesWithDeclaredEffects = collectNodesWithDeclaredEffects(
    contract,
    callGraph,
    extracted.annotationsByNode,
    externAliases,
  );
  const inScopeUnresolvedNodes = new Set<string>();
  for (const u of callGraph.unresolvedCalls) {
    if (inScopeUnresolvedNodes.has(u.fromId)) continue;
    if (nodesWithDeclaredEffects.has(u.fromId)) continue;
    if (matchAny(u.fromId, activeScopeMatchers)) {
      inScopeUnresolvedNodes.add(u.fromId);
    }
  }
  const effectiveByNode = applyUnresolvedFailClosed(
    propagation.effectiveByNode,
    declaredEffects,
    inScopeUnresolvedNodes,
  );

  const violations: Violation[] = [];
  const notices: Violation[] = [...suppressionResult.notices];

  // Emit one unresolved-call violation per (fromId, callSite) pair whose
  // caller is in-scope. Severity is always `error` — fail-closed restored.
  let unresolvedFailures = 0;
  for (const u of callGraph.unresolvedCalls) {
    if (!inScopeUnresolvedNodes.has(u.fromId)) {
      continue;
    }
    const node = nodeIndex.get(u.fromId);
    if (node === undefined) {
      continue;
    }
    const v = buildUnresolvedCallViolation({
      policy: undefined,
      node,
      unresolved: u,
      callGraph,
    });
    violations.push(v);
    unresolvedFailures += 1;
  }

  // Step 7 — per-policy checks. Use the (possibly-widened) effective map.
  // We pass `propagation` for evidence so the direct/inherited split
  // reflects the BEFORE-widening reality (a node widened to ALL declared
  // effects by D-CG-5 should still report the original direct set).
  const widenedPropagation: PropagationResult = {
    effectiveByNode,
    directByNode: propagation.directByNode,
    inheritedByNode: rebuildInherited(effectiveByNode, propagation.directByNode),
    rounds: propagation.rounds,
    propagationRoots: propagation.propagationRoots,
  };

  for (const policy of contract.effectPolicies) {
    if (policy.forbid !== undefined) {
      const matches = checkForbid({
        policy,
        callGraph,
        effectiveByNode: widenedPropagation.effectiveByNode,
        directByNode: widenedPropagation.directByNode,
        declaredEffects,
        externAliases,
      });
      for (const match of matches) {
        // If the offending effect was injected by D-CG-5 widening AND the
        // node had no direct/declared evidence for it, the D-CG-5
        // unresolved-call violation already covers it — skip to avoid
        // duplicate noise.
        if (
          inScopeUnresolvedNodes.has(match.node.id) &&
          !match.directOnNode &&
          !propagation.effectiveByNode.get(match.node.id)?.has(match.offendingEffect)
        ) {
          continue;
        }
        const evidence = buildEvidence(widenedPropagation, match, callGraph);
        violations.push(
          buildForbiddenEffectViolation({
            policy,
            node: match.node,
            evidence,
            callGraph,
            directOnNode: match.directOnNode,
          }),
        );
      }
    }
    if (policy.allowOnly !== undefined) {
      const allowExpanded = expandEffectPatterns(policy.allowOnly, declaredEffects);
      const matches = checkAllowOnly({
        policy,
        callGraph,
        effectiveByNode: widenedPropagation.effectiveByNode,
        directByNode: widenedPropagation.directByNode,
        declaredEffects,
        externAliases,
      });
      for (const match of matches) {
        if (
          inScopeUnresolvedNodes.has(match.node.id) &&
          !match.directOnNode &&
          !propagation.effectiveByNode.get(match.node.id)?.has(match.offendingEffect)
        ) {
          continue;
        }
        const evidence = buildEvidence(widenedPropagation, match, callGraph);
        violations.push(
          buildDisallowedEffectViolation({
            policy,
            node: match.node,
            evidence,
            callGraph,
            allowOnly: [...allowExpanded],
            directOnNode: match.directOnNode,
          }),
        );
      }
    }
  }

  let nodesAnalyzed = callGraph.nodes.length;
  // Defensive cast — keep nodesAnalyzed as number (not const-narrowed).
  nodesAnalyzed = Number(nodesAnalyzed);

  return {
    violations: Object.freeze(violations),
    notices: Object.freeze(notices),
    stats: {
      policiesEvaluated: contract.effectPolicies.length,
      nodesAnalyzed,
      unresolvedFailures,
      propagationRounds: propagation.rounds,
      suppressionsActive: suppressionResult.activeCount,
    },
    coverage: Object.freeze(coverage),
  };
}

function rebuildInherited(
  effective: ReadonlyMap<string, ReadonlySet<string>>,
  direct: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [id, eff] of effective.entries()) {
    const d = direct.get(id) ?? new Set<string>();
    const inherited = new Set<string>();
    for (const e of eff) {
      if (!d.has(e)) {
        inherited.add(e);
      }
    }
    const sorted = new Set<string>(
      [...inherited].sort((a, b) => stableStringCompare(a, b)),
    );
    out.set(id, sorted);
  }
  return out;
}
