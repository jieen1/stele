/**
 * Trace-policy evaluator. Top-level entry point: turns `contract.tracePolicies`
 * + a `CallGraph` into deterministic `Violation[]` + `notices[]`.
 *
 * Algorithm (per docs/design/phase-b/02-trace-based-policy.md §3):
 *   For each TracePolicyDeclaration:
 *     1. Compile patterns (target / must-transit / must-be-preceded-by / ...)
 *     2. Build targetSet and callerSet from the call graph nodes.
 *     3. Skip callers matching any exempt pattern.
 *     4. For each (caller, target) pair, enumerate paths (DFS, bounded).
 *     5. For each path: check must-transit / deny-direct / deny-transit.
 *     6. For each caller: scan body edges, check must-be-preceded-by /
 *        must-be-followed-by relative to target call sites.
 *   Cross-rule annotate (E-P0-1) — violations sharing group_id learn about
 *   each other via `also_violates` + `cross_rule_note`.
 */

import type {
  Contract,
  TracePolicyDeclaration,
  Violation,
} from "@stele/core";
import {
  compilePattern,
  resolveExternPattern,
  type CallGraph,
  type CallGraphNode,
  type CompiledPattern,
  type ConsumableCallGraph,
  type ExternAliasRegistry,
} from "@stele/call-graph-core";

import {
  checkDenyDirect,
  checkDenyTransit,
  checkMustBeFollowedBy,
  checkMustBePrecededBy,
  checkMustTransit,
} from "./constraint-checks.js";
import { annotateCrossRuleViolations } from "./cross-rule-dedup.js";
import {
  enumeratePaths,
  getOrderedOutgoingEdges,
} from "./path-enumeration.js";
import { buildViolation } from "./violation-builder.js";

export interface EvaluateTraceOptions {
  readonly contract: Contract;
  readonly callGraph: ConsumableCallGraph;
  readonly externAliases?: ExternAliasRegistry;
  readonly maxDepth?: number;
  readonly maxPaths?: number;
  /**
   * Round 2 D-CG-2 + Round 3 P0-5: in strict mode (default `true`), a
   * truncated path enumeration surfaces at the policy's configured severity
   * — incomplete analysis is treated as failure-to-prove. Lenient callers
   * (`false`) keep the legacy advisory `warning`.
   */
  readonly strictMode?: boolean;
}

export interface EvaluateTraceStats {
  readonly policiesEvaluated: number;
  readonly pathsEnumeratedTotal: number;
  readonly pathsCappedTotal: number;
}

/** Per-policy binding coverage — drives the zero-binding guard. */
export interface TracePolicyCoverage {
  readonly policyId: string;
  readonly severity: string;
  readonly targetsMatched: number;
  /**
   * Number of in-scope caller nodes the policy's scope actually matched in this
   * graph. A policy with targets but an empty scope (e.g. its scope file was
   * renamed) enforces nothing on any caller — the guard treats that as a
   * zero-binding error, not a silent green.
   */
  readonly scopeNodesMatched: number;
}

export interface EvaluateTraceResult {
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
  readonly stats: EvaluateTraceStats;
  readonly coverage: readonly TracePolicyCoverage[];
}

interface CompiledPolicy {
  readonly policy: TracePolicyDeclaration;
  readonly targetPatterns: readonly CompiledPattern[];
  readonly mustTransitPatterns: readonly CompiledPattern[];
  readonly mustBePrecededByPatterns: readonly CompiledPattern[];
  readonly mustBeFollowedByPatterns: readonly CompiledPattern[];
  readonly denyDirectPatterns: readonly CompiledPattern[];
  readonly denyTransitPatterns: readonly CompiledPattern[];
  readonly scopePatterns: readonly CompiledPattern[];
  readonly exemptPatterns: readonly CompiledPattern[];
}

function compileAll(
  rawPatterns: readonly string[],
  callGraphLanguage: CallGraph["language"],
  registry: ExternAliasRegistry | undefined,
): readonly CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (const p of rawPatterns) {
    let pattern = p;
    if (registry !== undefined) {
      const resolved = resolveExternPattern(pattern, callGraphLanguage, registry);
      if (resolved !== null) {
        pattern = resolved;
      }
    }
    compiled.push(compilePattern(pattern));
  }
  return Object.freeze(compiled);
}

function compilePolicy(
  policy: TracePolicyDeclaration,
  callGraph: CallGraph,
  registry: ExternAliasRegistry | undefined,
): CompiledPolicy {
  return {
    policy,
    targetPatterns: compileAll(policy.target, callGraph.language, registry),
    mustTransitPatterns: compileAll(policy.mustTransit, callGraph.language, registry),
    mustBePrecededByPatterns: compileAll(policy.mustBePrecededBy, callGraph.language, registry),
    mustBeFollowedByPatterns: compileAll(policy.mustBeFollowedBy, callGraph.language, registry),
    denyDirectPatterns: compileAll(policy.denyDirect, callGraph.language, registry),
    denyTransitPatterns: compileAll(policy.denyTransit, callGraph.language, registry),
    scopePatterns: compileAll(policy.scope, callGraph.language, registry),
    exemptPatterns: compileAll(
      policy.exempt.map((e) => e.pattern),
      callGraph.language,
      registry,
    ),
  };
}

function matchAny(nodeId: string, patterns: readonly CompiledPattern[]): boolean {
  for (const p of patterns) {
    if (p.matches(nodeId)) {
      return true;
    }
  }
  return false;
}

function buildTargetSet(
  callGraph: CallGraph,
  compiled: CompiledPolicy,
): { ownNodes: ReadonlySet<string>; allTargets: ReadonlySet<string> } {
  const ownTargets = new Set<string>();
  // Targets matched among the graph's own nodes (used for caller-set
  // construction). External-only targets are still tracked via allTargets
  // for path matching via `extern:` NodeIds present as edges.
  for (const n of callGraph.nodes) {
    if (matchAny(n.id, compiled.targetPatterns)) {
      ownTargets.add(n.id);
    }
  }
  // Also collect target NodeIds referenced as edge.toId — these include
  // extern: nodes that have no node record.
  const allTargets = new Set<string>(ownTargets);
  for (const e of callGraph.edges) {
    if (matchAny(e.toId, compiled.targetPatterns)) {
      allTargets.add(e.toId);
    }
  }
  return { ownNodes: ownTargets, allTargets };
}

function buildCallerSet(
  callGraph: CallGraph,
  compiled: CompiledPolicy,
): readonly CallGraphNode[] {
  const out: CallGraphNode[] = [];
  const scopeEmpty = compiled.scopePatterns.length === 0;
  for (const n of callGraph.nodes) {
    // Skip extern-prefixed nodes as callers (defensive — extractors should
    // not emit extern nodes, but pattern matching may still find them).
    if (n.id.startsWith("extern:")) {
      continue;
    }
    if (matchAny(n.id, compiled.exemptPatterns)) {
      continue;
    }
    if (scopeEmpty || matchAny(n.id, compiled.scopePatterns)) {
      out.push(n);
    }
  }
  return Object.freeze(out);
}

export function evaluateTracePolicies(
  options: EvaluateTraceOptions,
): EvaluateTraceResult {
  const {
    contract,
    callGraph,
    externAliases,
    maxDepth = 10,
    maxPaths = 100,
    strictMode = true,
  } = options;

  const violations: Violation[] = [];
  const notices: Violation[] = [];
  const coverage: TracePolicyCoverage[] = [];
  let pathsEnumeratedTotal = 0;
  let pathsCappedTotal = 0;

  if (contract.tracePolicies.length === 0) {
    return {
      violations: Object.freeze([]),
      notices: Object.freeze([]),
      stats: { policiesEvaluated: 0, pathsEnumeratedTotal: 0, pathsCappedTotal: 0 },
      coverage: Object.freeze([]),
    };
  }

  for (const policy of contract.tracePolicies) {
    const compiled = compilePolicy(policy, callGraph, externAliases);
    const { allTargets } = buildTargetSet(callGraph, compiled);
    const callerNodes = buildCallerSet(callGraph, compiled);
    coverage.push({
      policyId: policy.id,
      severity: policy.severity,
      targetsMatched: allTargets.size,
      scopeNodesMatched: callerNodes.length,
    });
    if (allTargets.size === 0) {
      // No matching targets at all in this graph — nothing to enforce. The
      // zero coverage recorded above lets the check stage's zero-binding guard
      // turn this into an error for error-severity policies instead of a
      // silent green (a policy that binds nothing protects nothing).
      continue;
    }

    for (const caller of callerNodes) {
      // ---- Path-based constraints (must-transit / deny-direct / deny-transit) ----
      const needsPathChecks =
        compiled.mustTransitPatterns.length > 0 ||
        compiled.denyDirectPatterns.length > 0 ||
        compiled.denyTransitPatterns.length > 0;

      if (needsPathChecks) {
        const result = enumeratePaths(
          callGraph,
          caller.id,
          allTargets,
          maxDepth,
          maxPaths,
        );
        pathsEnumeratedTotal += result.stats.pathsEnumerated;

        for (const path of result.paths) {
          const targetId = path.nodes[path.nodes.length - 1];
          if (targetId === undefined) {
            continue;
          }

          if (
            compiled.mustTransitPatterns.length > 0 &&
            checkMustTransit(path, compiled.mustTransitPatterns)
          ) {
            violations.push(
              buildViolation({
                policy,
                kind: "missing_transit",
                callerId: caller.id,
                targetId,
                path,
                missingPattern: policy.mustTransit[0],
                callGraph,
              }),
            );
          }

          if (
            compiled.denyDirectPatterns.length > 0 &&
            checkDenyDirect(path, caller.id, compiled.denyDirectPatterns)
          ) {
            violations.push(
              buildViolation({
                policy,
                kind: "direct_call_denied",
                callerId: caller.id,
                targetId,
                path,
                callGraph,
              }),
            );
          }

          if (compiled.denyTransitPatterns.length > 0) {
            const forbidden = checkDenyTransit(path, compiled.denyTransitPatterns);
            if (forbidden !== null) {
              violations.push(
                buildViolation({
                  policy,
                  kind: "forbidden_transit",
                  callerId: caller.id,
                  targetId,
                  path,
                  forbiddenTransitNode: forbidden,
                  callGraph,
                }),
              );
            }
          }
        }

        if (result.stats.truncated) {
          pathsCappedTotal += 1;
          // Round 3 P0-5: in strict mode this becomes an actual violation (not
          // merely a notice) because the analyzer cannot prove the policy
          // holds for the truncated paths.
          const depthCapViolation = buildViolation({
            policy,
            kind: "path_exceeded_max_depth",
            callerId: caller.id,
            callGraph,
            strictMode,
          });
          if (strictMode) {
            violations.push(depthCapViolation);
          } else {
            notices.push(depthCapViolation);
          }
        }
      }

      // ---- Sequence constraints (must-be-preceded-by / must-be-followed-by) ----
      const needsSeqChecks =
        compiled.mustBePrecededByPatterns.length > 0 ||
        compiled.mustBeFollowedByPatterns.length > 0;

      if (needsSeqChecks) {
        const bodyEdges = getOrderedOutgoingEdges(callGraph, caller.id);
        // For each direct target call in body, check sequence constraints.
        for (const edge of bodyEdges) {
          if (!matchAny(edge.toId, compiled.targetPatterns)) {
            continue;
          }
          const callSite = {
            path: caller.filePath,
            line: edge.line,
            column: edge.column,
          };
          if (
            compiled.mustBePrecededByPatterns.length > 0 &&
            checkMustBePrecededBy(
              bodyEdges,
              edge.line,
              edge.column,
              compiled.mustBePrecededByPatterns,
            )
          ) {
            violations.push(
              buildViolation({
                policy,
                kind: "missing_predecessor",
                callerId: caller.id,
                targetId: edge.toId,
                callSite,
                missingPattern: policy.mustBePrecededBy[0],
                callGraph,
              }),
            );
          }
          if (
            compiled.mustBeFollowedByPatterns.length > 0 &&
            checkMustBeFollowedBy(
              bodyEdges,
              edge.line,
              edge.column,
              compiled.mustBeFollowedByPatterns,
            )
          ) {
            violations.push(
              buildViolation({
                policy,
                kind: "missing_successor",
                callerId: caller.id,
                targetId: edge.toId,
                callSite,
                missingPattern: policy.mustBeFollowedBy[0],
                callGraph,
              }),
            );
          }
        }
      }
    }
  }

  // Cross-rule annotation across BOTH violations and notices (notice may
  // share group_id with a real violation; the agent benefits from knowing).
  //
  // Round 4 D-15 follow-up: the CLI `mergeCheckReports` ALSO runs
  // `annotateCrossRuleViolations` on the full cross-evaluator union. This
  // inner call is intentionally kept because:
  //   (a) Fixture tests in @stele/trace-evaluator consume the result
  //       directly (no CLI merge layer), and rely on intra-trace
  //       violation/notice cross-references being present.
  //   (b) `annotateCrossRuleViolations` is idempotent — re-annotating an
  //       already-annotated set produces the same fields, so running it
  //       twice is correctness-preserving even if mildly redundant.
  const combined = annotateCrossRuleViolations([...violations, ...notices]);
  const annotatedViolations: Violation[] = [];
  const annotatedNotices: Violation[] = [];
  for (const v of combined) {
    if (v.severity === "error") {
      annotatedViolations.push(v);
    } else {
      annotatedNotices.push(v);
    }
  }

  return {
    violations: Object.freeze(annotatedViolations),
    notices: Object.freeze(annotatedNotices),
    stats: {
      policiesEvaluated: contract.tracePolicies.length,
      pathsEnumeratedTotal,
      pathsCappedTotal,
    },
    coverage: Object.freeze(coverage),
  };
}
