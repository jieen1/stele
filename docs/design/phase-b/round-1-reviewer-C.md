# Phase B Design Review — Reviewer C (Stele Fit + Refactor + Philosophy)

## Philosophy Alignment

Overall: the three mechanisms (trace / type-state / effect) are philosophy-consistent — each violation produces a *deterministic, machine-interlock* error code with location and fix instruction. No "ask a human to review" surfaces. The fix-hint examples (`02 §六`, `03 §六`, `04 §七`) are explicitly addressed to the agent ("Insert `await permission.verify(...)` before…", "Move data fetching out of UserCard…"). That is what we want.

Two soft drift points:

1. **`03-type-state.md` §六 fix copy contains "Modify ORDER_LIFECYCLE.allowed-ops if business rules changed"** — that branch tells the agent it may unilaterally edit the contract. Contracts are protected; agent must use `propose` flow. Fix wording should say "*If business rules legitimately changed, open a design propose for ORDER_LIFECYCLE.*" Otherwise an over-eager agent could try (and get blocked by hooks anyway, but the message is mis-directed).
2. **`04-effect-system.md` §五 effect-suppression** is a designed escape hatch. The doc says `--strict-effects` warns each suppression — but warn-only on an escape hatch is exactly the "long-tail rot" surface the project wants to close. Default should be: `effect-suppression` requires `(reason "...")` like `exempt` in trace-policy, and `--strict-effects` upgrades to error. Otherwise suppression becomes the new "// eslint-disable-next-line".

Neither breaks the philosophy core; both are tightening wording.

## Refactor Soundness

**Item 1 — Delete multi-agent dead forms.** **Verified not fully dead.** The four forms ARE consumed by `packages/core/src/normalizer/normalize.ts` lines 28-31, 51-72, 233, 253 — they participate in normalized output and contract diff. The `validate-edit` MCP tool however does **NOT** read them (it only reads protected patterns). So:
- No runtime enforcement: correct, design doc accurate.
- But deletion impacts `normalize.ts` (4 Map constructions + the rendering branches) and any existing user `.stele` files that *parse* fine today will be rejected as "unknown form". The doc currently lists `structure-types.ts`, `structure-parse.ts`, `uniqueness.ts`, `structure.ts`, `index.ts` but **misses `packages/core/src/normalizer/normalize.ts`**. Add it.
- `docs/spec/cdl.md` §286-362 documents these forms publicly and claims `stele-validate-edit` consumes them — that documentation is wrong today (the tool doesn't), and Phase B doc correctly removes the spec section. Good.

**Item 2 — check.ts stage registry.** Sound. The 8 stages in current check.ts (lines 124-166 in `buildRawCheckReport` and `runCheckCommand`) duplicate the pipeline twice — registry fixes both at once. But the registry must handle the *filter pipeline* (`applyFiltersToReport(report, filters)`) which Phase A added between stages — design doc shows `reports.push(await stage.build(...))` without the filter wrapper. Add explicit filter responsibility (either inside the stage's build, or as an explicit post-step in `runAllStages`).

**Item 3 — typescript-shape → type-driven-evaluator.** Sound and aligned with Phase A's design (Phase A already named the stage `type-driven` knowing the package would consolidate). However:
- API takes `Contract` (`contract.brandedIds`, `contract.smartCtors`, `contract.typeStates`, `contract.effectPolicies`) but type-state/effect policies are project-scope, not contract-scope; semantically these aren't homogeneous. Decide upfront: input is the *whole normalized contract*, output is the *union of violations* per checker. That's the API to lock.
- Be explicit that this package depends on `@stele/call-graph-core` (for type-state, effect) — moving it out of `cli/` makes the dependency edge visible in `profile.yaml` integrations. Add a new `cli → type-driven-evaluator → call-graph-core` chain to profile.yaml or the layer-direction check will break.

**Item 4 — render-stele.ts split.** **Design doc claims 760+ lines; actual file is 537 lines.** The 760 figure may include planned Phase B additions. Recommend the split happens *after* Phase A stabilizes for a release tag, because:
- Existing tests `design-generator-ddd.test.ts` and `design-generator-type-driven.test.ts` assert CDL string outputs via `toEqual` / `toContain`. Byte-stability is NOT asserted as a single golden-string today, but each function's output is. Split that re-orders the *order* parts join in `renderAllDeclarations` (line 522-536) WILL break `ddd-generator-import-drift.test.ts`. Add explicit guard: golden snapshot of full output before and after refactor must be byte-equal.
- Phase A added `renderBrandedId` and `renderSmartCtor` (line 428-487) — these are the freshest code in the file. Splitting touches them; review must confirm Phase A's branded-id regex pattern handling and smart-ctor `deny_raw` field handling aren't lost.

**Item 5 — check stage registry static vs dynamic.** Design doc shows `CHECK_STAGES: readonly CheckStage[] = Object.freeze([...])` — **static array**. This is correct for Stele's purity model (one source-of-truth at module load). But `shouldRun(context, options)` is dynamic per-call. Good. One missing piece: stage *order* matters for some asserts (`protected` depends on `generated`'s output). The `dependsOn: ["generated"]` field plus topological sort is in the design, but the doc gives no example of two stages with no deps that have a stable order (alphabetical by id? declaration order?). Spec it: **declaration order** (predictable, deterministic).

**Item 6 — architecture-runtime merger.** Verified: `evaluateArchitectureFull` (line 86) and `evaluateArchitectureContract` (line 247) where the latter is a 3-line wrapper. Merger is trivially correct. File is 309 lines not 480 — workload over-estimated.

## Phase A Regression Risk

1. **`ALL_BACKENDS_COMPILE` invariant** (just added in Phase A). Phase B adds new packages (`call-graph-core`, `trace-evaluator`, `type-state-evaluator`, `effect-evaluator`, `type-driven-evaluator`). Each must compile to `dist/index.js` + `dist/index.d.ts` or this invariant fails on every check. Add to Phase B's exit criteria: each new package builds before its CDL form goes live.

2. **Branded-id + smart-ctor render path** — covered above (Refactor Item 4). The Phase A render functions are at line 428-487 in `render-stele.ts`; split must preserve byte-identical output. Run `pnpm test:packed-adoption` after the split — that's the only test that exercises the full chain end-to-end.

3. **`check-stages-type-driven.ts` is brand-new in Phase A.** Phase B "Item 3" wraps it under a new package — re-routing through `@stele/type-driven-evaluator`. Ensure the stage's *violation rule_id format* doesn't change (currently `type_driven.branded_id.*` / `type_driven.smart_ctor.*`). If the new package emits different prefixes, `last-report.json` baselines users created in Phase A will silently lose suppression.

4. **MCP hexagonal direction (`mcp.application` → `mcp.infrastructure`, fixed in Phase A).** No Phase B doc touches MCP, but `01-call-graph-extractor.md` proposes new extractor packages. None depend on MCP. Safe.

5. **Workspace cycle Phase A broke** — verify Phase B's `cli → type-driven-evaluator → call-graph-core` chain doesn't re-introduce one (the design has `call-graph-core` consumed by both `trace-evaluator` and the type-driven evaluators — that's a DAG, fine, as long as nothing imports back into `cli`).

## CDL Coherence

**Form style consistency.** `trace-policy` mirrors `invariant` and `core-node` form shape (id, description, severity, body fields). `type-state` matches `architecture` (id, target, declarative sub-clauses). `effect-declarations` / `effect-annotation` / `effect-policy` triplet is *new shape* — three forms collaborate, where the others are mostly self-contained. That's OK but document it: which form is mandatory for the others to work? (E0357 says effect-annotation must reference declared effects → ordering / cross-file requirement is implicit; make it explicit in spec.)

**Error codes E0330-E0359.** Continuous with existing E-codes (E0001-E03xx range used). 30 codes for 5 new forms is appropriate. No collision risk.

**Pattern syntax unification.** §五.1 in `06-cdl-extensions.md` introduces `structure-pattern.ts` with `ParsedPattern` — unified across `trace-policy`, `effect-annotation`, `effect-policy`. **Good.** But `type-state.target` uses `path::TypeName` (single string, no glob) while everything else uses NodeId glob. That's an inconsistency. Either:
- Allow `type-state.target` to be a glob (multiple types with the same state machine — useful for Go's separate-struct mapping in §六), OR
- Document explicitly that type-state is the exception and *why*.

**TOP_LEVEL_DECLARATIONS final set (19 forms).** Verified against `structure-types.ts` lines 3-24 — design lists exactly: drop 4 (agent/scope/inter-agent-contract/conflict), keep 14, add 5. Math checks out.

**`(stele-version "0.1")` not bumped despite 5 new forms.** §十二 in 06 says "向后兼容". Acceptable, but worth noting: a contract using `trace-policy` parsed by a v0.1-only validator would fail with "unknown form" — which IS the desired behavior for forward-incompatible features. Either bump to 0.2 *or* state in spec that "0.1 parser must reject unknown top-level forms" (already the validator behavior).

**profile.yaml schema churn.** §五 in 05 removes `type_driven.adt` and adds `type_driven.type_state`, `trace`, `effect` top-level. `packages/cli/src/design-profile/types.ts` line 155 still has `adt?: { entities[] }` and `validate.ts:304` still references it. Deprecation path (1 minor version of `@deprecated`) is correct, but design doc should specify: if a user's profile.yaml has both `adt` and Phase B fields, what happens? (Recommend: ignore `adt` with a notice, do not error.)

## Critical Issues

1. **Multi-agent deletion misses `normalize.ts`.** Add `packages/core/src/normalizer/normalize.ts` (lines 28-72, 233, 253) to the deletion list in `05-refactor-cleanup.md §一`. Also delete the `agent`/`scope`/`inter-agent-contract`/`conflict` sections from `docs/spec/cdl.md` §286-362 (the doc says "removed from spec" but doesn't note the spec currently lies about MCP integration — clarify the spec was wrong, not just outdated).

2. **render-stele.ts split byte-stability test.** Add explicit acceptance criterion: snapshot full `renderAllDeclarations` output before split and `diff -u` after. Without that, `ddd-generator-import-drift.test.ts` may fail or, worse, silently drift the user's protected `contract/generated/ddd-typedriven.stele`.

3. **Phase A's `type_driven.*` violation rule_id stability.** Phase B's `@stele/type-driven-evaluator` repackaging must preserve current rule_id strings — they're in baselines users have already created. Add to refactor doc: "rule_id strings frozen at Phase A's format; re-housing must not rename."

## Major Concerns

4. **Effect-suppression escape hatch is too lenient.** Default `(effect-suppression ...)` should require `(reason "...")` (mirror trace-policy `exempt`) and `--strict-effects` should error not warn. Otherwise long-tail rot eats the system.

5. **Type-state fix-hint copy invites agent to edit contract.** Reword `03 §六 fix (c)` to direct agent to design-propose flow, not direct contract edit.

6. **CDL pattern syntax exception for type-state.target** undocumented. Either unify or call out the exception.

7. **New packages must be in `ALL_BACKENDS_COMPILE`** (or its successor checker) — Phase A added this invariant precisely so new package additions don't ship broken. Phase B's 5 new packages need explicit registration.

8. **Engineering estimates are inflated** by ~30%: render-stele is 537 lines not 760+; architecture-runtime is 309 not 480. Likely also overestimated for CallGraphExtractors. Not blocking, but reset expectations.

## What's Good

- Three mechanisms (trace / type-state / effect) really do cover behavior-level rot beyond what architecture/invariant/code-shape catch. Targeted and necessary.
- Error-feedback format (`§六` in 02, 04) is best-in-class for agent self-correction: rule_id + actual chain + expected + fix hint + fingerprint. Wins the philosophy alignment.
- CallGraphExtractor as shared trait (`01`) is the right base abstraction. Avoids 3× duplication across the three evaluators.
- Two-wave language strategy (TS+Python first, Go/Java/Rust second) is pragmatic. Avoids "5-language half-done" failure mode.
- D-B-002 (don't do ADT exhaustiveness) is correct restraint. Profile field cleanup follows through.
- Refactor-bundled-with-feature philosophy (Item 一 §十 execution sequence) is right — separating refactor sprints is what calcifies legacy code.
- `06 §九` splitting `contract/generated/` into two files (ddd-typedriven + effect-policies) is sound — keeps semantic concerns separated in user-visible artifacts.
- Profile.yaml deprecation path for `adt` (one-version `@deprecated`) honors the project's commitment to user contract stability.
