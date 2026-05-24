# Phase 7 — Documentation + Independent Reviewer Cycle

**Goal:** Document the new self-dogfooding state, run independent
reviewer rounds (Round 15+), fix all HIGH/MED findings, repeat until
the reviewer reports nothing substantive.

**Why:** The 6 implementation phases each shipped contracts +
negative tests. Phase 7 is the cumulative validation: does the whole
thing actually hang together? Reviewer rounds have caught real bugs
in every Stele round since Round 4 — Phase 7 expects the same.

**Estimated effort:** 2–3 days of writing, plus 3–10 days of reviewer
turn-around (depending on findings).

**Out of scope:**
- New mechanism work
- Performance tuning beyond what's documented
- New Phase B language adapters

## Required dependencies

- Phases 0–6 all complete and committed

## Steps

### Step 7.1 — Update self-protection coverage matrix

**File:** `docs/internal/self-protection-coverage-matrix.md` (new)

Build a matrix: rows = the 14 advertised contract mechanisms,
columns = the 17 workspace packages. Cell = "✅ N contracts" /
"⚠️ partial" / "❌ none".

Goal: after Phase 6, every row should have at least one ✅ for at
least one package.

### Step 7.2 — Update CLAUDE.md

`CLAUDE.md` currently says the repo protects itself via "the
`@stele/claude-code-plugin` and the 42 self-protection invariants".
Update to reflect the new counts (~84 invariants) and the new
mechanisms in use (`trace-policy`, `effect-policy`, `type-state`,
`code-shape`, `branded-id`).

### Step 7.3 — Write the self-dogfooding summary doc

**File:** `docs/internal/self-dogfooding-2026-Q2.md` (new)

Single document summarizing what changed under this plan:

- The 6 phases + their contract counts
- The shape of each new contract category
- Anything deferred (with rationale)
- Round 15+ findings + fixes
- The new invariant count (final number)
- Decision log (from README.md)

### Step 7.4 — Round 15: Independent reviewer

Launch a sub-agent with this prompt:

> You are Round 15 Reviewer T. Audit commits since
> `git merge-base origin/main HEAD~<N>` (the start of the
> self-dogfooding plan). The plan documents are in
> `docs/design/self-dogfooding/`. Your job: find substantive
> (HIGH/MED) bugs introduced by the plan's execution. Skip nitpicks.
>
> Focus areas:
> - Did Phase 1 actually replace ALL raw-string uses of the 5
>   branded types? grep + count.
> - Are the Phase 3 trace policies actually enforced — i.e. does
>   `stele check` re-extract the call graph and run the evaluator,
>   or is it cached from a stale build?
> - Phase 4 effect annotations: are any public @stele/core APIs
>   missing JSDoc tags?
> - Phase 5 type-state: do the phantom types actually prevent
>   wrong-state calls at TS compile-time, or are they erased?
> - Phase 6 aggregate class-shape: does removing a required method
>   from a real aggregate ACTUALLY fail `stele check`?
>
> Up to 8 findings.

### Step 7.5 — Fix Round 15 findings

Each HIGH/MED finding gets a focused commit + negative test +
re-lock.

### Step 7.6 — Round 16: regression hunter

Launch a second reviewer to look specifically at whether the Round
15 fixes introduced new bypasses.

### Step 7.7 — Repeat until convergence

Per the existing rounds pattern: keep going until a round returns 0
substantive findings.

### Step 7.8 — Final commit + push

Single commit summarizing:

- New invariant count
- New negative test count
- Mechanism coverage matrix link
- Reviewer round count + final outcome

```
node packages/cli/dist/index.js check     # exit 0
node packages/cli/dist/index.js list | wc -l   # should be ~84
git push origin main
```

### Step 7.9 — Phase 4 effect-evaluator follow-ups (added Round 15/16)

The Round 15 audit and Round 16 regression hunt surfaced two
concrete effect-evaluator improvements that the original Phase 4
plan did not anticipate. Both should be tracked as discrete future
work rather than rolled into a single "Phase 4 done" claim.

**7.9.1 — Per-policy unresolved-call scoping.** Today the effect
evaluator's `unresolved_call_blocks_evaluation` errors fire for the
WHOLE call graph the moment any unresolved call exists, regardless
of whether the unresolved call falls inside any policy's
`target-scope`. This forced Phase 4 to ship `effectStrictMode: false`
in `stele.config.json` to downgrade ~1,454 such errors to warnings.
The principled fix:

- In `@stele/effect-evaluator`, change the unresolved-call check so
  it only emits a violation when the unresolved call node falls
  inside at least one active policy's `target-scope` glob.
- Removes the global fail-closed escape hatch; restores fail-closed
  semantics per Round 2 D-CG-5 for the policies that actually care.
- After the change lands, remove `effectStrictMode: false` from
  `stele.config.json` and confirm `stele check` exit 0 with the same
  4 policies still active.

Acceptance: `stele check` reports zero `unresolved_call_blocks_evaluation`
errors for `tests/conformance/runner-impl.ts` (a noisy known case
outside any policy scope), while still reporting one if a function
inside `packages/core/src/manifest/**` has unresolved calls.

**7.9.2 — Enable allowJs (or .ts migration) for hook-script
coverage.** The `HOOK_NO_NETWORK` effect-policy
(`contract/main.stele:676`) targets `packages/claude-code-plugin/scripts/*.js`
but the TS call-graph extractor sets `allowJs: false` and its
fallback directory walker only collects `.ts/.tsx` — so the policy
is dead by construction. Pick ONE:

- (a) Enable `allowJs: true` in
  `packages/backend-typescript/src/extractors/call-graph.ts:222`
  and update the directory walker at line 269 to also collect
  `.js/.cjs/.mjs`. Run the full `stele check` + benchmark before
  / after — the larger call graph may slow Phase B evaluators
  noticeably; if so, gate behind a config flag.
- (b) Migrate hook scripts to `.ts` with a `tsup`-based build into
  `packages/claude-code-plugin/dist/scripts/`. Update
  `packages/claude-code-plugin/hooks/hooks.json` to point at the
  built `.js` artefacts. Heavier refactor but no extractor-wide
  change.

Acceptance: `test_hook_no_network_catches_fetch_in_hook_script` is
re-enabled (drop the `@pytest.mark.skip` decorator); the test
passes against a real call-graph that includes hook scripts.

**Tracking:** both items have their root-cause analysis recorded in
`docs/design/self-dogfooding/README.md` decision-log entries
("HOOK_NO_NETWORK policy is dead by construction" and
"effectStrictMode: false is a policy degradation"). When either is
landed, the corresponding decision-log entry should be appended (not
edited) with the resolution commit SHA and a one-line outcome.

## Acceptance criteria

- [ ] Coverage matrix doc written
- [ ] CLAUDE.md updated
- [ ] Self-dogfooding summary doc written
- [ ] At least 1 reviewer round completed
- [ ] All HIGH/MED reviewer findings fixed
- [ ] Final reviewer round returns 0 substantive findings
- [ ] `stele check` exit 0 with the final invariant count

## Dependencies

- All 6 prior phases

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding/README.md and
docs/design/self-dogfooding/phase-7-docs-and-review.md.

Execute steps 7.1 → 7.3 (doc writing). Then dispatch reviewer
sub-agents per 7.4 / 7.6 — the main agent does this; sub-agent
should not launch additional sub-agents.

After each reviewer round, return the findings to the main agent
with a recommendation: "fix these N HIGH/MED items, or stop here".
```
