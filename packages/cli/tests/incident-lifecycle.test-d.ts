/**
 * Incident-wedge type-state self-protection — compile-time test for
 * `INCIDENT_LIFECYCLE` phantom-state discipline.
 *
 * Pinned `@ts-expect-error` sites assert that the brand discriminator keeps
 * Drafted, TeethProven, and Bound witnesses non-interchangeable, and that the
 * apply→generate→lock sink can only ever be reached with a Bound witness. To
 * check by hand that the brand still fires, remove one annotation and run
 * `pnpm --filter @stele/cli typecheck` — tsc must surface a TS2345
 * argument-not-assignable error.
 */

import {
  bindTeethProof,
  draftProvenDraft,
  markTeethProven,
  type ProvenDraft,
  type ProvenDraftPayload,
} from "../src/commands/incident/incident-lifecycle.js";

const payload: ProvenDraftPayload = {
  id: "fixture-incident",
  invariant: {
    id: "FIXTURE_INVARIANT",
    severity: "error",
    description: "fixture",
    assert: "(true)",
  },
  rationale: "fixture rationale",
  tags: ["provenance:incident"],
  draft: {
    intent: "fixture",
    fixSha: "0".repeat(40),
    parentSha: "1".repeat(40),
    invariantCdl: "(invariant FIXTURE_INVARIANT (assert (true)))",
    negativeTest: "def test_x(): assert False",
    testFilename: "test_incident_fixture.py",
  },
  approvedBy: "user@example.com",
  teethVerdict: "TEETH_PROVEN",
};

// Happy path: each transition runs exactly once.
const d0: ProvenDraft<"Drafted"> = draftProvenDraft(payload);
const d1: ProvenDraft<"TeethProven"> = markTeethProven(d0);
const d2: ProvenDraft<"Bound"> = bindTeethProof(d1);
void d2;

// 1. Cannot bind a still-Drafted witness — must pass through markTeethProven
//    (the enforceTeethGate gate) first.
// @ts-expect-error — Drafted cannot be passed where TeethProven is required
bindTeethProof(d0);

// 2. Cannot re-run markTeethProven on a Bound witness — Bound is forward-only.
// @ts-expect-error — Bound cannot be passed where Drafted is required
markTeethProven(d2);

// 3. A raw `ProvenDraftPayload` is not assignable to `ProvenDraft<"Drafted">`
//    without going through `draftProvenDraft` — the brand cannot be smuggled.
// @ts-expect-error — ProvenDraftPayload is not assignable to ProvenDraft<"Drafted">
const smuggled: ProvenDraft<"Drafted"> = payload;
void smuggled;

// 4. KEYSTONE: the apply→generate→lock sink accepts only `ProvenDraft<"Bound">`.
//    A Drafted witness (or any non-Bound state) MUST be rejected where the sink
//    requires Bound — reaching apply/generate/lock requires the full gate chain.
const sink = (_bound: ProvenDraft<"Bound">): void => {};
// @ts-expect-error — Drafted cannot be passed where the sink requires Bound
sink(d0);
