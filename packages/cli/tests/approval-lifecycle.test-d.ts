/**
 * Phase 5.2 type-state self-protection — compile-time test for
 * `APPROVAL_LIFECYCLE` phantom-state discipline.
 *
 * Pinned `@ts-expect-error` sites assert that the brand discriminator
 * keeps Drafting, IdentityChecked, and Signed approvals
 * non-interchangeable. To check by hand that the brand still fires,
 * remove one annotation and run `pnpm --filter @stele/cli typecheck` —
 * tsc must surface a TS2345 argument-not-assignable error.
 */

import {
  attachApprovedBy,
  draftApproval,
  signApproval,
  writeSignedApproval,
  type Approval,
  type ApprovalPayload,
} from "../src/commands/design/approval-lifecycle.js";

const payload: ApprovalPayload = {
  schema_version: 1,
  base_profile_sha256: null,
  approved_profile_sha256: "0".repeat(64),
  approved_proposals: [],
  diff_classification: "additive",
  affected_generated_rules: [],
  affected_source_scope: [],
  reason: "fixture",
  approved_by: "user@example.com",
  approved_at: "1970-01-01T00:00:00Z",
};

// Happy path: each transition runs exactly once.
const drafting: Approval<"Drafting"> = draftApproval(payload);
const checked: Approval<"IdentityChecked"> = attachApprovedBy(drafting);
const signed: Approval<"Signed"> = signApproval(checked);
void signed;

// 1. Cannot sign a still-Drafting approval — must pass through the
//    identity gate first.
// @ts-expect-error — Drafting cannot be passed where IdentityChecked is required
signApproval(drafting);

// 2. Cannot re-run `attachApprovedBy` on a Signed approval.
// @ts-expect-error — Signed cannot be passed where Drafting is required
attachApprovedBy(signed);

// 3. A raw `ApprovalPayload` is not assignable to `Approval<"Drafting">`
//    without going through `draftApproval` — the brand cannot be smuggled.
// @ts-expect-error — ApprovalPayload is not assignable to Approval<"Drafting">
const smuggled: Approval<"Drafting"> = payload;
void smuggled;

// 4. Closeout 4: `writeSignedApproval` accepts only `Approval<"Signed">`.
//    Passing a Drafting brand MUST fail — the persist site is the runtime
//    gate that the identity check + signing transitions happened.
// @ts-expect-error — Drafting cannot be passed where writeSignedApproval requires Signed
writeSignedApproval(drafting, "contract/design/approvals/x.json");
