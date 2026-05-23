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
 *   5. For each unresolved call in the graph: in strictMode (default true,
 *      Round 2 D-CG-1) emit a fail-closed violation
 *      `effect.unresolved_call_blocks_evaluation` AND opaquely include all
 *      declared effects on the offending node's effective set (Round 2
 *      D-CG-5). In lenient mode emit a notice and leave the set alone.
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
import type {
  Contract,
  EffectAnnotationDeclaration,
  Violation,
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
   * Round 2 D-CG-1: strict default true. When true, unresolved calls
   * produce `error`-severity violations AND fail-closed (the node's
   * effective effects are widened to include every declared effect).
   * When false, unresolved calls produce advisory notices and do not
   * widen the set.
   */
  readonly strictMode?: boolean;
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

export interface EvaluateEffectResult {
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
  readonly stats: EvaluateEffectStats;
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
    directEffectsOnNode: [...direct].sort((a, b) => a.localeCompare(b)),
    inheritedEffects: [...inherited].sort((a, b) => a.localeCompare(b)),
    propagationRootNodes: [...rootList].sort((a, b) => a.localeCompare(b)),
    propagationChain: chain,
  };
}

/**
 * Apply Round 2 D-CG-5: in strictMode, widen every unresolved-call node's
 * effective set to include all declared effects. Returns a NEW effective
 * map (input is unchanged).
 */
function applyUnresolvedFailClosed(
  effectiveByNode: ReadonlyMap<string, ReadonlySet<string>>,
  callGraph: CallGraph,
  declaredEffects: ReadonlySet<string>,
  strictMode: boolean,
): {
  effective: ReadonlyMap<string, ReadonlySet<string>>;
  unresolvedNodes: ReadonlySet<string>;
} {
  const unresolvedNodes = new Set<string>();
  for (const u of callGraph.unresolvedCalls) {
    unresolvedNodes.add(u.fromId);
  }
  if (!strictMode || unresolvedNodes.size === 0 || declaredEffects.size === 0) {
    return { effective: effectiveByNode, unresolvedNodes };
  }
  const out = new Map<string, ReadonlySet<string>>(effectiveByNode);
  for (const id of unresolvedNodes) {
    const previous = out.get(id) ?? new Set<string>();
    out.set(id, unionEffects(previous, declaredEffects));
  }
  return { effective: out, unresolvedNodes };
}

export async function evaluateEffects(
  options: EvaluateEffectOptions,
): Promise<EvaluateEffectResult> {
  const { contract, callGraph, extractor, externAliases } = options;
  const strictMode = options.strictMode ?? true;

  // Step 1 — declared effect name table.
  const declaredEffects = flattenDeclaredEffects(contract);

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

  // Step 6 — D-CG-5 fail-closed widening for unresolved-call nodes.
  const { effective: effectiveByNode, unresolvedNodes } = applyUnresolvedFailClosed(
    propagation.effectiveByNode,
    callGraph,
    declaredEffects,
    strictMode,
  );

  const violations: Violation[] = [];
  const notices: Violation[] = [...suppressionResult.notices];

  // Emit unresolved-call violations / notices.
  const nodeIndex = nodesById(callGraph);
  let unresolvedFailures = 0;
  for (const u of callGraph.unresolvedCalls) {
    const node = nodeIndex.get(u.fromId);
    if (node === undefined) {
      continue;
    }
    const v = buildUnresolvedCallViolation({
      policy: undefined,
      node,
      unresolved: u,
      callGraph,
      strictMode,
    });
    if (strictMode) {
      violations.push(v);
      unresolvedFailures += 1;
    } else {
      notices.push(v);
    }
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
          unresolvedNodes.has(match.node.id) &&
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
          unresolvedNodes.has(match.node.id) &&
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
      [...inherited].sort((a, b) => a.localeCompare(b)),
    );
    out.set(id, sorted);
  }
  return out;
}
