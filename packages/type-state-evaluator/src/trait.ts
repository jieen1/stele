/**
 * TypeStateInferenceExtractor trait. Implemented by per-backend extractors
 * (TypeScript phantom types, Python typing.Generic, Rust PhantomData, Java
 * sealed types, Go separate-types) to answer one question:
 *
 *   "At call site (caller, line, col), what state was the receiver variable
 *    `receiverName` in?"
 *
 * The trait is intentionally state-agnostic: the evaluator doesn't care HOW
 * the backend inferred the state, only WHAT state it produced (and where the
 * inference originated, for the `inference_source` field in violations —
 * Round 2 E-P1-1).
 *
 * Cross-function propagation is opt-in via `TypeStateBindingDeclaration[]`
 * (Round 1 MC-2). A backend may consult bindings when inferring states for
 * call sites whose receiver flowed through a function parameter, but the
 * evaluator does NOT propagate states across function boundaries on its own.
 */

import type {
  CallGraph,
  SupportedLanguage,
} from "@stele/call-graph-core";
import type {
  TypeStateBindingDeclaration,
  TypeStateDeclaration,
} from "@stele/core";

/**
 * State inferred for a variable at a specific call site.
 *
 * `inferredState === undefined` means inference attempted but failed
 * (complex control flow, untyped parameter, callback / async erasure).
 * The evaluator turns failures into either errors (strictMode=true) or
 * notices (strictMode=false).
 */
export interface InferredStateAtCallSite {
  /** Caller function NodeId — must match a node in the CallGraph. */
  readonly callerId: string;
  /** Call site location within the caller's body. */
  readonly callSite: { readonly line: number; readonly column: number };
  /** Identifier of the receiver variable at the call site (e.g. "order"). */
  readonly receiverName: string;
  /** Method/operation name being invoked (e.g. "addItem"). */
  readonly method: string;
  /** Type-state declaration this inference pertains to. */
  readonly declarationId: string;
  /** Inferred state name (e.g. "Paid"). `undefined` when inference failed. */
  readonly inferredState: string | undefined;
  /**
   * Optional: when the receiver resolves to a parameter of the caller
   * function, the visible parameter index (skipping `this`). The evaluator
   * uses this to correlate the inferred state against a
   * `(type-state-binding ...)` declaration that pins a state for the
   * same parameter index — disagreement yields
   * `typestate.<id>.wrong_state_at_binding`.
   */
  readonly receiverParamIndex?: number;
  /** Why the state was inferred (for inference_source in violations). */
  readonly inferenceReason: string | undefined;
  /** Where the inference originated (e.g. the createOrder() return site). */
  readonly inferenceOrigin?: {
    readonly path: string;
    readonly line: number;
    readonly column: number;
  };
  /** Chain of state transitions leading to `inferredState`. */
  readonly flowSteps: readonly string[];
}

export interface InferTypeStatesOptions {
  readonly callGraph: CallGraph;
  /** Type-state declarations to infer for. */
  readonly declarations: readonly TypeStateDeclaration[];
  /** Optional bindings — backends use these for cross-boundary parameters. */
  readonly bindings: readonly TypeStateBindingDeclaration[];
  /** Project root, for resolving file paths. */
  readonly projectRoot: string;
}

export interface InferTypeStatesResult {
  /** All call sites where inference produced (or attempted) a state. */
  readonly inferences: readonly InferredStateAtCallSite[];
}

export interface TypeStateInferenceExtractor {
  readonly language: SupportedLanguage;
  inferTypeStates(options: InferTypeStatesOptions): Promise<InferTypeStatesResult>;
}
