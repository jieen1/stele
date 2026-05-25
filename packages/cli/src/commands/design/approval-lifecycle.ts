/**
 * Phase 5.2 self-dogfooding — APPROVAL_LIFECYCLE phantom types.
 *
 * An approval record cannot be written to disk before the human-identity
 * gate has run. We encode the three-step lifecycle (Drafting → IdentityChecked
 * → Signed) as a state-keyed brand on the `Approval<S>` shape so a caller
 * that tries to persist a Drafting record fails at tsc.
 *
 * The runtime cost is zero — the brand is a phantom type. The smart
 * constructors `draftApproval` / `attachApprovedBy` / `signApproval` enforce
 * the transition sequence at the type level.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type ApprovalState = "Drafting" | "IdentityChecked" | "Signed";

export type ApprovalStateBrand<S extends ApprovalState> = {
  readonly [K in ApprovalState as `__approval_state_${K}`]: K extends S ? true : never;
};

/**
 * Plain approval payload — the JSON shape that ends up on disk.
 * The `approved_by` field only becomes meaningfully attributable once
 * the identity gate has run.
 */
export interface ApprovalPayload {
  readonly schema_version: 1;
  readonly base_profile_sha256: string | null;
  readonly approved_profile_sha256: string;
  readonly approved_proposals: ReadonlyArray<{ path: string; sha256: string }>;
  readonly diff_classification: string;
  readonly affected_generated_rules: readonly string[];
  readonly affected_source_scope: readonly string[];
  readonly reason: string;
  readonly approved_by: string;
  readonly approved_at: string;
}

export type Approval<S extends ApprovalState = "Drafting"> = ApprovalPayload &
  ApprovalStateBrand<S>;

/**
 * Mint a fresh Drafting approval. The runtime cast is unsafe but the
 * brand is purely type-level, so the only cost is the function call.
 */
export function draftApproval(payload: ApprovalPayload): Approval<"Drafting"> {
  return payload as Approval<"Drafting">;
}

/**
 * Tag an approval as having passed the human-identity gate. Only a
 * Drafting approval may be promoted.
 */
export function attachApprovedBy(
  approval: Approval<"Drafting">,
): Approval<"IdentityChecked"> {
  return approval as unknown as Approval<"IdentityChecked">;
}

/**
 * Promote an identity-checked approval to Signed. Only IdentityChecked
 * approvals may transition here; the on-disk write should ONLY accept
 * Approval<"Signed">.
 */
export function signApproval(
  approval: Approval<"IdentityChecked">,
): Approval<"Signed"> {
  return approval as unknown as Approval<"Signed">;
}

/**
 * Closeout 4 (self-dogfooding plan): typed write entry for an approval
 * record. Accepts only an `Approval<"Signed">` value so the persist
 * site cannot serialise a Drafting or IdentityChecked record — both
 * pre-attribution states are bytes-on-disk vulnerabilities.
 *
 * Internally writes the JSON via `writeFileSync` (the existing approve
 * implementation; the wrapper exists solely to gate the write with the
 * brand).
 *
 * @stele:effects fs.write
 */
export function writeSignedApproval(
  approval: Approval<"Signed">,
  approvalPath: string,
): void {
  // Resolve the input path before the write — same path-safety
  // contract every other CLI-side fs write follows (CLI_IO_THROUGH_PATH_UTILS).
  const absolute = resolve(approvalPath);
  writeFileSync(absolute, JSON.stringify(approval, null, 2), "utf8");
}
