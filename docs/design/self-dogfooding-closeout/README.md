# Self-Dogfooding Closeout Plan — Zero Gaps, No Shortcuts

**Status:** plan (2026-05-25)
**Owner:** main agent
**Tracking ID:** `selfdogfood-closeout-2026Q2`
**Predecessor:** `docs/design/self-dogfooding/` (the 7-phase plan that
left 7 substantive gaps documented in the decision log)

## Why this document exists

The 7-phase self-dogfooding plan landed broad mechanism coverage but
left 7 substantive gaps the original plan explicitly registered as
"Phase 7 follow-ups". A reviewer challenge in this session forced a
re-accounting that revealed the gaps are not minor — they include
one global policy degradation (`effectStrictMode: false`), one
dead-by-construction policy (`HOOK_NO_NETWORK`), 9 unbound
class-shapes, an entire type-state evaluator binding zero production
call sites, plus a depth-cap analyzer error and 5 deferred contracts.

This document closes every one of them. **Zero gaps. Zero shortcuts.
Zero hacks. Zero new opt-out knobs.** Every closeout is a real
mechanism-level upgrade plus comprehensive test coverage — never a
config flip, never a skip, never a mock-it-away.

## Forbidden anti-patterns (the bar this closeout must clear)

The following moves are **forbidden** for every sub-agent on every
closeout. If the obvious-looking path uses any of these, the
sub-agent must STOP and surface the conflict to the main agent.

1. **Adding a config flag that downgrades severity, scope, or fail-
   closed behaviour.** `effectStrictMode: false` is the case study
   we are closing — do not invent its replacement.
2. **`@pytest.mark.skip` to silence a failing assertion**, unless the
   test targets a mechanism that is provably dead-by-construction
   AND a separate closeout exists to fix the root cause. Even then,
   the skip is temporary and must come with a `xfail`-style assertion
   that fails loudly the moment the underlying fix lands.
3. **Mock returns / monkey-patches** to make a checker pass.
4. **Hard-coded allow-lists** that bypass evaluation for "known
   problematic" call sites.
5. **Editing source code under `packages/`** to make a CDL contract
   pass. Contracts are the spec; source is what they check. If a
   contract is wrong, fix the contract via propose/approve. If the
   evaluator is wrong, fix the evaluator. Never the symptom side.
6. **Narrowing a policy's `target-scope` to exclude a real failing
   call site** without an approved propose document explaining
   exactly why that call site is provably acceptable.
7. **`@ts-ignore`, `@ts-expect-error` without a matching test-d.ts
   assertion that the error fires**, or `any` casts in production
   code to satisfy a type-policy.
8. **Commenting out a test** — equivalent to skip and equally
   forbidden.
9. **Bumping a threshold / `maxDepth` / `maxPaths` / similar
   analyzer budget** to make a contract pass, without a written
   justification in the decision log of why the larger budget is
   correct rather than papering over a real issue.
10. **Marking a class-shape / function-shape `(must-have-method X)`
    as optional** to dodge a binding miss.

If the sub-agent's most obvious next move matches one of these, STOP
and ask. There is always a principled alternative.

## Cross-cutting rules (inherited verbatim from the predecessor plan)

CC-1 through CC-11 from `../self-dogfooding/README.md` apply
verbatim. The most important rules in this closeout:

- **CC-1** — No silent skipping. Surface failures.
- **CC-2** — Every contract has a paired negative test that uses
  `assert`. **Plus the additional CC-13 below.**
- **CC-3** — Green between every commit: `pnpm build`, `pnpm typecheck`,
  `stele check`, `pytest tests/contract`, `pytest test_negative.py`.
- **CC-4** — No backward-compat shims, no removed-flag toggles.
  When you delete `effectStrictMode`, delete it everywhere.
- **CC-9** — `stele.config.json::targetLanguage` stays `"python"`.
- **CC-10** — Reviewer cycle is non-optional. Closeout 7 runs
  Round 17 + Round 18+ until two consecutive rounds return zero
  substantive findings.

### Additional rules for this closeout (CC-12, CC-13, CC-14)

- **CC-12** — No source edit to make a CDL contract pass.
- **CC-13** — Test coverage gate: every closeout must add
  **multiple** test layers:
  - Unit tests for evaluator/mechanism changes
    (`packages/<evaluator>/tests/`)
  - Integration / golden-snapshot tests where applicable
    (`packages/cli/tests/`)
  - At least **2 paired negative tests of DIFFERENT shape** per
    new/changed contract:
    - **Test A:** mutation that removes the enforcement target
      (e.g. delete the method/field/import the contract asserts
      must exist).
    - **Test B:** mutation that violates the constraint in a
      different way — change a value, introduce a forbidden
      sibling, alter a type. **Two removals of the same kind do not
      count as two tests** (anti-vacuity rule).
    - If the natural Test B is structurally impossible (e.g. a
      contract that only checks "this method must exist"), STOP
      and escalate — the contract itself is probably under-
      specified.
  - Where contracts are generated, the design-generator's own unit
    tests must cover the new generation path
- **CC-14** — RESOLVED accounting: every closeout commit message
  must list which gap-rows from `README.md` it closes. The final
  closeout-7 commit must verify every "Phase 7 follow-up" /
  "deferred" entry in `docs/design/self-dogfooding/README.md` has
  a "RESOLVED in commit <sha>" line appended.

## The 7 gaps

| # | Gap | Mechanism | Severity |
|---|---|---|---|
| 1 | `effectStrictMode: false` global downgrade | effect-evaluator | MED (policy degradation) |
| 2 | `HOOK_NO_NETWORK` dead policy (`allowJs:false` in TS extractor) | call-graph extractor | HIGH (policy completely inert) |
| 3 | 9 aggregate class-shapes deferred (target = free function, not class) | class-shape evaluator | HIGH (9 contracts non-functional) |
| 4 | Phase 5 type-state evaluator binds zero production call sites | type-state evaluator / @stele/core API surface | HIGH (compile-time-only enforcement; runtime path bypasses) |
| 5 | `trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth` | trace evaluator / depth cap | MED (one contract partially enforced) |
| 6 | 3 Phase 2 + 2 Phase 3 deferred contracts | code-shape + trace-policy + extern-alias | MED (5 missing contracts) |
| 7 | Independent review rounds (Round 17+) | process | LOW (procedural) |

## Closeout plan

| Closeout | Topic | Mechanism touched | Depends on |
|---|---|---|---|
| **1** | Per-policy unresolved-call scoping (real mechanism upgrade, no fallback knob) | `@stele/effect-evaluator` | — |
| **2** | TS extractor `allowJs` + `.js/.cjs/.mjs` walker; HOOK_NO_NETWORK re-activated and proven | `@stele/backend-typescript` extractor | — |
| **3a** | Class-shape evaluator gains first-class free-function-aggregate support | `packages/cli/src/code-shape/evaluate.ts` + evaluator unit tests | — |
| **3b** | Populate 9 aggregate class-shapes via design generator + 9 × 2 negative tests | `contract/design/profile.yaml`, generator | 3a |
| **4** | Route every production caller through typed lifecycle methods; type-state evaluator binds them | `@stele/core`, `@stele/cli`, `@stele/call-graph-core` | — |
| **5** | Eliminate trace depth-cap error via narrower scope OR partial-path caching (principled, not threshold bump) | trace evaluator + policy scope | — |
| **6** | Land 5 deferred contracts: Phase 2 × 3 (code-shape) + Phase 3 × 2 (trace-policy + boundary refactor for backend-load) | code-shape, trace-policy, code-shape boundary | 2 (Phase 3's EVALUATOR_VIA_EXTERN_REGISTRY needs the bigger graph), 3a (for any class-shape on free-functions among the 3 Phase 2) |
| **7** | Reviewer rounds 17 → ∞ until **two consecutive** rounds return zero substantive | process | 1–6 |

Closeouts are dispatched **serially**. Each is verified end-to-end
by the main agent before the next starts.

## Execution model

1. Main agent reads this README + the per-closeout document
2. Main agent dispatches a sub-agent with that document as input
3. Sub-agent reports commit SHAs + full CC-3 evidence
4. Main agent re-runs CC-3 independently and inspects the diff for
   anti-pattern matches (the 10 forbidden moves) before next
   dispatch
5. After closeouts 1–6 complete, main agent dispatches Round 17 +
   Round 18, repeating until two consecutive rounds return 0
   HIGH/MED findings

Sub-agent rules:

- Read the README + assigned closeout doc first
- Refuse to take actions outside the doc's scope
- Surface ambiguity in writing before acting
- Run CC-3 before AND after every commit
- Match every change against the 10-item forbidden anti-pattern list
  in this README; if even one matches, STOP and report
- Never edit source to make a CDL contract pass (CC-12)
- Negative tests must use `assert`, never `return`; CC-13 demands at
  least 2 per new/changed contract
- Never skip hooks, never push, never dispatch other sub-agents
- Return commit SHAs and the full CC-3 output of the final commit
- Pyproject's `filterwarnings = ["error::pytest.PytestReturnNotNoneWarning"]`
  is your friend; trust the failure if it surfaces.

## Acceptance for the whole closeout

When all 7 closeouts complete:

- [ ] `stele check` exit 0. Zero errors. Zero warnings that
  represent silenced policy failures (warnings from active
  `effect-suppression` declarations are OK and intentional).
- [ ] `effectStrictMode` field deleted from `SteleConfig`,
  `stele.config.json`, and every reference in code or docs.
  `grep -rn "effectStrictMode\|strictMode" packages/ stele.config.json contract/`
  returns zero hits in non-historical paths.
- [ ] HOOK_NO_NETWORK has **2** paired negative tests of different
  shape (per CC-13); neither is `@pytest.mark.skip`; both use
  `assert`; both pass against real `.js` files in the call graph.
- [ ] All **10** aggregate class-shapes are populated and bound to
  their targets. Each has **at least 2 paired negative tests of
  different shape** (per CC-13). The existing operator-registry
  aggregate already has 2; the other 9 each need 2 new tests →
  **18 new + verify operator-registry's 2 = 20 total tests** on the
  aggregate class-shapes.
- [ ] Type-state evaluator reports >0 bound call sites for each of
  the 4 lifecycles. At least one production call site per lifecycle
  routes through the typed methods.
- [ ] The 5 previously-deferred contracts are live with at least 2
  paired negative tests each.
- [ ] No `@pytest.mark.skip` decorators remain except those
  documenting an intentional, future-tracked dead-by-design test
  (which there should be zero of after this closeout).
- [ ] No `@ts-expect-error` without a matching test-d.ts assertion
  proving the error fires.
- [ ] Two consecutive review rounds return 0 HIGH/MED substantive
  findings.
- [ ] All decision-log entries in the predecessor `README.md` that
  ended with "Phase 7 follow-up" or "deferred" have an "RESOLVED in
  commit <sha>" line appended.
