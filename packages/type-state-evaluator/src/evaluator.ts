/**
 * Type-state evaluator. Top-level entry point: turns
 *   `contract.typeStates` +
 *   `contract.typeStateBindings` +
 *   a `CallGraph` +
 *   a per-backend `TypeStateInferenceExtractor`
 * into deterministic `Violation[]` + `notices[]`.
 *
 * Algorithm (per docs/design/phase-b/03-type-state.md §4):
 *
 *   For each TypeStateDeclaration decl:
 *     1. Build target method set — every call-graph node that "belongs to"
 *        decl.target. Class targets ("file::Type") match nodes whose
 *        container chain ends in Type. Glob targets (Go separate-types)
 *        compile via @stele/call-graph-core compilePattern.
 *     2. For each edge into a target method, ask the backend extractor
 *        for the receiver's inferred state at that call site.
 *     3. Classify the call as:
 *        a) legitimate transition (`method` is the via-of a transition
 *           whose from contains inferredState) — no violation
 *        b) legitimate allowed-op (method in allowed-ops[inferredState])
 *           — no violation
 *        c) disallowed — emit `typestate.<id>.disallowed_op` (priority
 *           blocking)
 *        d) inference failed — emit `typestate.<id>.inference_failed`;
 *           in strictMode (default true) severity=error, otherwise
 *           severity=warning routed to `notices` (Round 2 D-CG-1)
 *
 *   Inference failures for callers covered by a matching
 *   `(type-state-binding ...)` are suppressed — the binding tells us the
 *   author already explicitly annotated the state, so a backend that
 *   couldn't recover it on its own is forgiven for this caller.
 */

import {
  compilePattern,
  parseNodeId,
  resolveExternPattern,
} from "@stele/call-graph-core";
import type {
  CallGraph,
  CallGraphEdge,
  CallGraphNode,
  ConsumableCallGraph,
  ExternAliasRegistry,
} from "@stele/call-graph-core";
import {
  createViolation,
  ruleId,
  stableStringCompare,
  type Contract,
  type TypeStateBindingDeclaration,
  type TypeStateDeclaration,
  type Violation,
} from "@stele/core";

import {
  methodIsAllowedOp,
  methodIsTransition,
  unreachableStates,
} from "./state-machine.js";
import type {
  InferTypeStatesResult,
  InferredStateAtCallSite,
  TypeStateInferenceExtractor,
} from "./trait.js";
import type { InferenceSource } from "./types.js";
import {
  buildDisallowedOpViolation,
  buildInferenceFailedViolation,
  buildWrongStateAtBindingViolation,
} from "./violation-builder.js";

export interface EvaluateTypeStateOptions {
  readonly contract: Contract;
  readonly callGraph: ConsumableCallGraph;
  readonly extractor: TypeStateInferenceExtractor;
  /**
   * When true (default per Round 2 D-CG-1), inference failures become
   * errors. When false, they become severity=warning notices and do not
   * contribute to the returned `violations` array.
   */
  readonly strictMode?: boolean;
  /**
   * Round 4 D-07: cross-language alias registry built from
   * `(extern-alias ...)` declarations in the contract. When present, any
   * `extern:<logical-name>::...` target pattern on a type-state declaration
   * is resolved through this registry before being matched against the
   * call graph.
   */
  readonly externAliases?: ExternAliasRegistry;
}

export interface EvaluateTypeStateStats {
  readonly declarationsEvaluated: number;
  readonly callSitesAnalyzed: number;
  readonly inferenceFailures: number;
}

/** Per-declaration binding coverage — drives the zero-binding guard. */
export interface TypeStateCoverage {
  readonly declarationId: string;
  readonly severity: string;
  readonly callSitesAnalyzed: number;
  readonly filePath: string;
}

export interface EvaluateTypeStateResult {
  readonly violations: readonly Violation[];
  readonly notices: readonly Violation[];
  readonly stats: EvaluateTypeStateStats;
  readonly coverage: readonly TypeStateCoverage[];
}

interface TargetMatcher {
  matches(nodeId: string): boolean;
}

/**
 * Convert a simple wildcard pattern (only `*` / `?`) into a RegExp. Used for
 * the path and type-name segments of a type-state target. We deliberately do
 * NOT support brace expansion or character classes here — that level of
 * pattern lives in @stele/call-graph-core compilePattern, and we delegate
 * full-NodeId globs to that function below.
 */
function simpleGlobToRegExp(glob: string): RegExp {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") {
      re += ".*";
    } else if (ch === "?") {
      re += ".";
    } else if (/[.+^$|(){}\\\][]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}

/**
 * Build a TargetMatcher for a `(target ...)` value. Three forms:
 *
 *   1. Plain `path::TypeName` (no glob metachars): match nodes whose
 *      container chain ends in TypeName AND whose file path equals `path`.
 *      Free-function targets (no container) match when symbolName equals
 *      TypeName.
 *
 *   2. Type-glob form `path-or-glob::TypeGlob`: the part after the LAST `::`
 *      is a simple `* / ?` pattern (e.g. `*Order` for Go separate-types,
 *      Round 1 MC-3). Match nodes whose container chain ends in a name
 *      matching the type-glob AND whose file path matches the path-glob.
 *
 *   3. Full NodeId glob (advanced authors): if neither (1) nor (2) suits
 *      (e.g. the pattern includes `(arity)` or `**::`), delegate to
 *      `@stele/call-graph-core`'s `compilePattern` for full NodeId matching.
 */
function buildTargetMatcher(
  target: string,
  callGraphLanguage: CallGraph["language"],
  externAliases: ExternAliasRegistry | undefined,
): TargetMatcher {
  // Round 4 D-07: resolve `extern:` patterns through the registry first;
  // downstream parsing (sepIdx split, compilePattern dispatch) sees the
  // already-resolved per-language form.
  if (externAliases !== undefined) {
    const resolved = resolveExternPattern(target, callGraphLanguage, externAliases);
    if (resolved !== null) {
      target = resolved;
    }
  }
  const sepIdx = target.lastIndexOf("::");
  if (sepIdx < 0) {
    // Defensive: shouldn't reach here (validator enforces `::`), but degrade
    // gracefully to a no-match matcher so we never crash the evaluator.
    return { matches: () => false };
  }
  const pathPart = target.slice(0, sepIdx);
  const typePart = target.slice(sepIdx + 2);

  // If the typePart contains `(` or starts with `**::` etc, treat the whole
  // thing as a full NodeId glob and let compilePattern handle it.
  if (typePart.includes("(") || pathPart.includes("**") || typePart.includes("**")) {
    const compiled = compilePattern(target);
    return { matches: (id: string) => compiled.matches(id) };
  }

  const pathIsGlob = /[*?]/.test(pathPart);
  const typeIsGlob = /[*?]/.test(typePart);
  const pathRegex = pathIsGlob ? simpleGlobToRegExp(pathPart) : null;
  const typeRegex = typeIsGlob ? simpleGlobToRegExp(typePart) : null;

  return {
    matches: (id: string) => {
      const parsed = parseNodeId(id);
      if (parsed === null || parsed.filePath === undefined) {
        return false;
      }
      // Path check.
      if (pathRegex === null) {
        if (parsed.filePath !== pathPart) {
          return false;
        }
      } else if (!pathRegex.test(parsed.filePath)) {
        return false;
      }
      // Type check.
      const last = parsed.container[parsed.container.length - 1];
      const typeMatchValue = last ?? parsed.symbolName;
      if (typeRegex === null) {
        if (last === typePart) {
          return true;
        }
        if (parsed.symbolName === typePart && parsed.container.length === 0) {
          return true;
        }
        return false;
      }
      return typeRegex.test(typeMatchValue);
    },
  };
}

/**
 * Build an extra matcher that recognises decl.stateTypeMapping targets
 * (Go separate-types: state Draft → DraftOrder, state Submitted →
 * SubmittedOrder). When any mapping target's TypeName matches a node's
 * container/symbol, that node is considered a target method of this decl.
 */
function buildStateTypeMappingMatcher(
  decl: TypeStateDeclaration,
  callGraphLanguage: CallGraph["language"],
  externAliases: ExternAliasRegistry | undefined,
): TargetMatcher | null {
  if (decl.stateTypeMapping.length === 0) {
    return null;
  }
  const matchers: TargetMatcher[] = decl.stateTypeMapping.map((m) =>
    buildTargetMatcher(m.target, callGraphLanguage, externAliases),
  );
  return {
    matches: (id: string) => matchers.some((m) => m.matches(id)),
  };
}

function methodNameOf(nodeId: string): string | null {
  const parsed = parseNodeId(nodeId);
  return parsed === null ? null : parsed.symbolName;
}

function findNode(callGraph: CallGraph, id: string): CallGraphNode | undefined {
  for (const n of callGraph.nodes) {
    if (n.id === id) {
      return n;
    }
  }
  return undefined;
}

/**
 * Locate the call-graph edge whose (fromId, line, column) matches a given
 * inference. Returns undefined if no such edge exists — defensive guard
 * against a backend that produces inferences for sites not in the graph.
 */
function findEdgeFor(
  callGraph: CallGraph,
  callerId: string,
  line: number,
  column: number,
): CallGraphEdge | undefined {
  for (const e of callGraph.edges) {
    if (e.fromId !== callerId) {
      continue;
    }
    if (e.callSite.line === line && e.callSite.column === column) {
      return e;
    }
  }
  return undefined;
}

function bindingMatchesCaller(
  binding: TypeStateBindingDeclaration,
  callerId: string,
): boolean {
  // Bindings reference functions by NodeId. We accept exact match OR the
  // binding NodeId without disambiguator matching the caller's full id
  // up to "(arity)" (i.e. agent supplied a non-disambiguated NodeId).
  if (binding.function === callerId) {
    return true;
  }
  // Strip optional `#disambig` suffix from binding.function and compare.
  const bindingStripped = binding.function.replace(/#[0-9a-f]{8}$/, "");
  const callerStripped = callerId.replace(/#[0-9a-f]{8}$/, "");
  return bindingStripped === callerStripped;
}

function anyBindingCovers(
  bindings: readonly TypeStateBindingDeclaration[],
  callerId: string,
): boolean {
  for (const b of bindings) {
    if (bindingMatchesCaller(b, callerId)) {
      return true;
    }
  }
  return false;
}

/**
 * Closeout 4 helper: find the binding's declared state for a specific
 * parameter index of a caller. Returns the state string or `null` if no
 * binding covers the caller, or covers it but does not pin this param.
 */
function findBindingStateForParam(
  bindings: readonly TypeStateBindingDeclaration[],
  callerId: string,
  paramIndex: number,
): string | null {
  for (const b of bindings) {
    if (!bindingMatchesCaller(b, callerId)) continue;
    for (const p of b.params) {
      if (p.index === paramIndex) {
        return p.state;
      }
    }
  }
  return null;
}

/**
 * Build the InferenceSource that travels with a disallowed-op violation
 * (Round 2 E-P1-1).
 */
function inferenceSourceFrom(inference: InferredStateAtCallSite): InferenceSource {
  return {
    origin: inference.inferenceOrigin,
    reason: inference.inferenceReason,
    flowSteps: inference.flowSteps,
  };
}

interface CompiledDeclaration {
  readonly decl: TypeStateDeclaration;
  readonly targetMatcher: TargetMatcher;
  /** Optional secondary matcher for state-type-mapping entries (Go). */
  readonly stateTypeMatcher: TargetMatcher | null;
  /** Transition `via` + allowed-op names — free-function transition sites. */
  readonly transitionNames: ReadonlySet<string>;
  /** File path of decl.target; free transition functions live in this file. */
  readonly targetFilePath: string | null;
}

/** Names of every transition `via` and allowed-op for a declaration. */
function transitionNamesOf(decl: TypeStateDeclaration): ReadonlySet<string> {
  const names = new Set<string>();
  for (const t of decl.transitions) {
    names.add(t.via);
  }
  for (const ops of decl.allowedOps.values()) {
    for (const op of ops) {
      names.add(op);
    }
  }
  return names;
}

/** The `path` portion of a `path::Type` target, or null when malformed. */
function targetFilePathOf(target: string): string | null {
  const sepIdx = target.lastIndexOf("::");
  return sepIdx <= 0 ? null : target.slice(0, sepIdx);
}

function compileDeclarations(
  declarations: readonly TypeStateDeclaration[],
  callGraphLanguage: CallGraph["language"],
  externAliases: ExternAliasRegistry | undefined,
): readonly CompiledDeclaration[] {
  const out: CompiledDeclaration[] = [];
  for (const decl of declarations) {
    out.push({
      decl,
      targetMatcher: buildTargetMatcher(decl.target, callGraphLanguage, externAliases),
      stateTypeMatcher: buildStateTypeMappingMatcher(decl, callGraphLanguage, externAliases),
      transitionNames: transitionNamesOf(decl),
      targetFilePath: targetFilePathOf(decl.target),
    });
  }
  return Object.freeze(out);
}

function declarationCoversNode(
  compiled: CompiledDeclaration,
  nodeId: string,
): boolean {
  if (compiled.targetMatcher.matches(nodeId)) {
    return true;
  }
  if (compiled.stateTypeMatcher !== null && compiled.stateTypeMatcher.matches(nodeId)) {
    return true;
  }
  // Free-function transition: a node whose symbol is one of this decl's
  // transition/allowed-op names AND that lives in the target's file. The
  // extractor reports the lifecycle argument as the receiver; the call lands
  // on the free function, so the edge target is the function, not the type.
  if (compiled.targetFilePath !== null && compiled.transitionNames.size > 0) {
    const parsed = parseNodeId(nodeId);
    if (
      parsed !== null &&
      parsed.filePath === compiled.targetFilePath &&
      compiled.transitionNames.has(parsed.symbolName)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Group inferences by declaration ID + (callerId, line, column) so we can
 * iterate efficiently and stay deterministic.
 */
function indexInferences(
  result: InferTypeStatesResult,
): ReadonlyMap<string, readonly InferredStateAtCallSite[]> {
  const map = new Map<string, InferredStateAtCallSite[]>();
  for (const inf of result.inferences) {
    const key = inf.declarationId;
    let bucket = map.get(key);
    if (bucket === undefined) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(inf);
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => {
      const fileCmp = stableStringCompare(a.callerId, b.callerId);
      if (fileCmp !== 0) {
        return fileCmp;
      }
      if (a.callSite.line !== b.callSite.line) {
        return a.callSite.line - b.callSite.line;
      }
      if (a.callSite.column !== b.callSite.column) {
        return a.callSite.column - b.callSite.column;
      }
      return stableStringCompare(a.method, b.method);
    });
  }
  return map;
}

export async function evaluateTypeStates(
  options: EvaluateTypeStateOptions,
): Promise<EvaluateTypeStateResult> {
  const { contract, callGraph, extractor, externAliases } = options;
  const strictMode = options.strictMode ?? true;

  const declarations = contract.typeStates;
  const bindings = contract.typeStateBindings;

  if (declarations.length === 0) {
    return {
      violations: Object.freeze([]),
      notices: Object.freeze([]),
      stats: {
        declarationsEvaluated: 0,
        callSitesAnalyzed: 0,
        inferenceFailures: 0,
      },
      coverage: Object.freeze([]),
    };
  }

  const inferResult = await extractor.inferTypeStates({
    callGraph,
    declarations,
    bindings,
    projectRoot: callGraph.projectRoot,
  });
  const inferIndex = indexInferences(inferResult);
  const compiled = compileDeclarations(declarations, callGraph.language, externAliases);

  const violations: Violation[] = [];
  const notices: Violation[] = [];
  const coverage: TypeStateCoverage[] = [];
  let callSitesAnalyzed = 0;
  let inferenceFailures = 0;

  for (const c of compiled) {
    const decl = c.decl;
    const bucket = inferIndex.get(decl.id) ?? [];
    let declSitesAnalyzed = 0;

    for (const inference of bucket) {
      // Defensive: skip inferences that the backend produced for an edge
      // not actually in the graph. Maintainer of T4.3 must keep these
      // consistent, but the evaluator should not crash on drift.
      const edge = findEdgeFor(
        callGraph,
        inference.callerId,
        inference.callSite.line,
        inference.callSite.column,
      );

      if (edge === undefined) {
        continue;
      }

      // Must target a method that belongs to this declaration. Free-function
      // transition inferences (`lockManifest(m)`) are exempt from this check:
      // the extractor already verified the callee name is one of the decl's
      // transition/allowed-op names AND the argument is typed as the target,
      // so the binding is sound. The edge's `toId` for a cross-package call
      // is an `extern:` node that declarationCoversNode (file-path scoped)
      // would wrongly reject, dropping a genuine lifecycle driver.
      if (!inference.viaFreeFunction && !declarationCoversNode(c, edge.toId)) {
        continue;
      }

      callSitesAnalyzed += 1;
      declSitesAnalyzed += 1;

      const method = inference.method.length > 0
        ? inference.method
        : methodNameOf(edge.toId) ?? "<unknown>";
      const callerFilePath =
        findNode(callGraph, inference.callerId)?.filePath ?? "";
      const callSite = {
        path: callerFilePath,
        line: inference.callSite.line,
        column: inference.callSite.column,
      };

      if (inference.inferredState === undefined) {
        inferenceFailures += 1;
        if (anyBindingCovers(bindings, inference.callerId)) {
          // Binding explicitly handled this caller — backend's inability
          // to infer is not the agent's problem.
          continue;
        }
        const v = buildInferenceFailedViolation({
          decl,
          callerId: inference.callerId,
          callSite,
          method,
          callGraph,
          receiverName: inference.receiverName,
          strictMode,
        });
        if (strictMode) {
          violations.push(v);
        } else {
          notices.push(v);
        }
        continue;
      }

      // Inferred state is known. Four possibilities:
      const state = inference.inferredState;

      // Closeout 4: when the receiver resolves to a parameter of the
      // caller AND a `(type-state-binding ...)` exists declaring a state
      // for that parameter, the binding's state must agree with what
      // the static type system inferred. Disagreement is its own
      // violation kind — distinct from disallowed_op (which checks the
      // method against the inferred state) and inference_failed (which
      // fires only when inference produced no state).
      if (inference.receiverParamIndex !== undefined) {
        const bindingState = findBindingStateForParam(
          bindings,
          inference.callerId,
          inference.receiverParamIndex,
        );
        if (bindingState !== null && bindingState !== state) {
          // Only emit when both states are members of THIS declaration's
          // state set; mismatches against an unrelated lifecycle's state
          // are not this declaration's business.
          if (decl.states.includes(bindingState) && decl.states.includes(state)) {
            violations.push(
              buildWrongStateAtBindingViolation({
                decl,
                callerId: inference.callerId,
                callSite,
                method,
                paramIndex: inference.receiverParamIndex,
                declaredState: bindingState,
                inferredState: state,
                inferenceSource: inferenceSourceFrom(inference),
                callGraph,
                receiverName: inference.receiverName,
              }),
            );
            // Do not also fire disallowed_op for this call site — the
            // mismatch IS the finding, and we don't want to double-report.
            continue;
          }
        }
      }

      if (methodIsTransition(decl, state, method)) {
        // Legitimate transition out of `state` — no violation.
        continue;
      }
      if (methodIsAllowedOp(decl, state, method)) {
        // Explicit allow — no violation.
        continue;
      }

      // Otherwise: disallowed op. Emit blocking violation.
      violations.push(
        buildDisallowedOpViolation({
          decl,
          callerId: inference.callerId,
          callSite,
          method,
          inferredState: state,
          inferenceSource: inferenceSourceFrom(inference),
          callGraph,
          receiverName: inference.receiverName,
        }),
      );
    }

    coverage.push({
      declarationId: decl.id,
      severity: decl.severity,
      callSitesAnalyzed: declSitesAnalyzed,
      filePath: decl.filePath ?? "contract",
    });
  }

  // Round 4 F-C-08: emit a notice for any state declared in `decl.states`
  // that cannot be reached from `decl.initial`. Previously this was a
  // silent acceptance — a contract with an unreachable state would pass
  // `stele check` even though the declaration is structurally suspect.
  for (const decl of declarations) {
    const unreached = unreachableStates(decl);
    if (unreached.length === 0) continue;
    notices.push(
      createViolation({
        rule_id: ruleId(`typestate.${decl.id}.unreachable_state`),
        rule_kind: "typestate_unreachable_state",
        severity: "warning",
        source: { tool: "stele", command: "check", kind: "typestate" },
        location: { path: decl.filePath ?? "contract" },
        cause: {
          summary:
            `Type-state \`${decl.id}\` declares state(s) [${unreached.join(", ")}] ` +
            `that cannot be reached from initial state \`${decl.initial}\`. ` +
            `Either remove the unreachable states or add a transition reaching them.`,
        },
        scope_paths: [decl.filePath ?? "contract"],
        priority: "minor",
        group_id: decl.id,
      }),
    );
  }

  return {
    violations: Object.freeze(violations),
    notices: Object.freeze(notices),
    stats: {
      declarationsEvaluated: declarations.length,
      callSitesAnalyzed,
      inferenceFailures,
    },
    coverage: Object.freeze(coverage),
  };
}
