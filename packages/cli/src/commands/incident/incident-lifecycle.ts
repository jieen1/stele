/**
 * Incident-wedge self-protection — INCIDENT_LIFECYCLE phantom types.
 *
 * An incident draft cannot reach the atomic apply→generate→lock sink before
 * the teeth proof has been gated AND bound to this exact draft. We encode the
 * three-step lifecycle (Drafted → TeethProven → Bound) as a state-keyed brand
 * on the `ProvenDraft<S>` shape so a caller that tries to apply/generate/lock
 * a draft that has not passed the gate fails at tsc.
 *
 * This is ADDITIVE defense of the code path: it defends against future
 * refactors / new callers reaching apply→generate→lock without routing
 * through `enforceTeethGate` (→ markTeethProven) and `enforceTeethBinding`
 * (→ bindTeethProof). It is ORTHOGONAL to — and does NOT replace — the runtime
 * `enforceTeethBinding` content-hash/parentSha/fixSha tamper-evidence check,
 * which defends byte tampering. Both checks stay.
 *
 * The runtime cost is zero — the brand is a phantom type. The smart
 * constructors `draftProvenDraft` / `markTeethProven` / `bindTeethProof`
 * enforce the transition sequence at the type level only (runtime no-ops).
 *
 * TEETH-UNAVAILABLE BRANCH (do NOT "tighten" this): when an approval is made
 * via --teeth-unavailable-reason, the runtime SKIPS enforceTeethBinding (the
 * content-hash check has no proof to bind). The lifecycle MUST still reach
 * Bound in that branch: there, "Bound" means "the gate decided
 * teeth-unavailable and recorded a reason"; in the proven branch "Bound" means
 * "enforceTeethBinding confirmed the proof attests to THIS draft". Both paths
 * legitimately reach the sink, so `bindTeethProof` is a pure type-level witness
 * and must NOT require the runtime binding check to have run. Tightening it
 * would break teeth-unavailable approvals.
 */

import type { IncidentDraft } from "./shared.js";
import type { ParsedInvariant, TeethGateResult } from "./approve.js";

export type ProvenDraftState = "Drafted" | "TeethProven" | "Bound";

export type ProvenDraftStateBrand<S extends ProvenDraftState> = {
  readonly [K in ProvenDraftState as `__proven_draft_state_${K}`]: K extends S
    ? true
    : never;
};

/**
 * The already-validated approval inputs the apply→generate→lock sink needs.
 * The witness transports this data into the sink so it is not merely a phantom
 * marker — the sink reads invariant/rationale/tags/draft off the Bound witness.
 */
export interface ProvenDraftPayload {
  readonly id: string;
  readonly invariant: ParsedInvariant;
  readonly rationale: string;
  readonly tags: readonly string[];
  readonly draft: IncidentDraft;
  readonly approvedBy: string;
  readonly teethVerdict: TeethGateResult["verdict"];
  readonly unavailableReason?: string;
}

export type ProvenDraft<S extends ProvenDraftState = "Drafted"> =
  ProvenDraftPayload & ProvenDraftStateBrand<S>;

/**
 * Mint a fresh Drafted witness from the assembled, post-gate payload. The
 * runtime cast is unsafe but the brand is purely type-level, so the only cost
 * is the function call.
 */
export function draftProvenDraft(payload: ProvenDraftPayload): ProvenDraft<"Drafted"> {
  return payload as ProvenDraft<"Drafted">;
}

/**
 * Promote a Drafted witness to TeethProven. Call ONLY after `enforceTeethGate`
 * has returned without throwing (TEETH_PROVEN, or an explicit teeth-unavailable
 * reason — both are accepted gate decisions). Only a Drafted witness may be
 * promoted.
 */
export function markTeethProven(d: ProvenDraft<"Drafted">): ProvenDraft<"TeethProven"> {
  return d as unknown as ProvenDraft<"TeethProven">;
}

/**
 * Promote a TeethProven witness to Bound — the terminal state the
 * apply→generate→lock sink accepts. Call ONLY after `enforceTeethBinding` has
 * returned without throwing (proven branch), OR after the gate decided
 * teeth-unavailable (binding is skipped by design — see the file header). Only
 * a TeethProven witness may be promoted; the sink must accept ONLY
 * `ProvenDraft<"Bound">`.
 */
export function bindTeethProof(d: ProvenDraft<"TeethProven">): ProvenDraft<"Bound"> {
  return d as unknown as ProvenDraft<"Bound">;
}
