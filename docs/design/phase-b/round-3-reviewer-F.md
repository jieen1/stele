# Phase B Round 3 Review — Reviewer F (Design vs Implementation Consistency)

Scope: did the shipped code at `v0.3.0-b1` actually deliver what `FINAL-SPEC.md` promised? All findings cite file:line or reproducible commands. I ran the test suites and `stele check` myself; I did NOT trust commit messages.

## Critical Gaps Between Design and Code

1. **Trace depth-cap-exceeded silently downgraded to warning** — contradicts FINAL-SPEC §一 + Round 2 D-CG-2 ("depth-cap default error in strict mode").
   - `packages/trace-evaluator/src/violation-builder.ts:68-70` hard-codes `severity = "warning"` for kind `path_exceeded_max_depth`, irrespective of mode.
   - `packages/trace-evaluator/src/evaluator.ts:281-291` always pushes the result into `notices`, never `violations`.
   - `EvaluateTraceOptions` (evaluator.ts:46-52) has **no `strictMode` field at all** — trace evaluator cannot honour D-CG-2 even if a caller wanted to.
   - Repro: `grep -n "strictMode" packages/trace-evaluator/src/evaluator.ts` returns 0 matches.

2. **`(extern-alias …)` CDL form is not parseable in production.**
   - `packages/call-graph-core/src/extern-alias.ts:7,41,117` defines the API (`buildExternAliasRegistry`, `resolveExternPattern`).
   - `packages/trace-evaluator/src/evaluator.ts:86-91` consumes it.
   - But `grep -rn "extern-alias" packages/core/src/` returns **zero matches** — no `parseExternAliasDeclaration` in the structural parser; `Contract` has no `externAliases` field.
   - `packages/cli/src/commands/check-stages-trace.ts:174` only passes `deps.externAliases` from the test-injection seam. Production users writing `(extern-alias logical (typescript "pkg"))` in their `.stele` will silently get nothing.
   - This contradicts FINAL-SPEC §二 "06-cdl-extensions.md ... extern-alias + type-state-binding" (Round 1 修订完毕) and is a real surprise for users following the spec.

3. **Cross-rule dedup is limited to within-trace only.** FINAL-SPEC §一.2.5 promises "trace + effect 同一根源 violation 显式提示 '修了 X 之后 Y 会跟着挪到新位置'".
   - `packages/trace-evaluator/src/cross-rule-dedup.ts:40` (`annotateCrossRuleViolations`) is only called inside `packages/trace-evaluator/src/evaluator.ts:360`.
   - `grep -rn "annotateCrossRule\|also_violates" packages/cli/src/ packages/effect-evaluator/src/ packages/type-state-evaluator/src/` returns 0 hits → no cross-stage merging. The `effect.<id>.forbidden_effect` and `trace.<id>.missing_predecessor` from the same NodeId will NOT learn about each other.
   - `resolves_with` field exists in the schema (`packages/core/src/report/types.ts:127,217`) but is never populated by any evaluator.

4. **`packages/cli/src/commands/check-stages-trace.ts:181-186`** counts only `result.violations` toward `ok` and merges `notices` as informational. Combined with #1, depth-cap exceeded never blocks a check — opposite of D-CG-2.

## Mechanism-by-Mechanism Findings

### Trace-Based Policy
- **OK** All 5 constraint kinds implemented: `packages/trace-evaluator/src/evaluator.ts:231-353` calls each of `checkMustTransit / checkDenyDirect / checkDenyTransit / checkMustBePrecededBy / checkMustBeFollowedBy` (constraint-checks.ts).
- **OK (per spec)** Algorithm is bounded DFS, not worklist. Round 2 MC-7's "worklist + reverse postorder" requirement was scoped to the **effect** propagation only — see `docs/design/phase-b/04-effect-system.md:217-225`. Spec for trace (02-trace-based-policy.md:51) explicitly says DFS. So this is fine.
- **OK** Depth cap default = 10 — `evaluator.ts:181` `maxDepth = 10`; cap-hit triggers `path_exceeded_max_depth` (path-enumeration.ts:104-132).
- **NOT OK** Cap-hit is warning, never error (see Critical #1).
- **PARTIAL** Extern-alias resolution exists in the evaluator (`evaluator.ts:86-91`) but the registry is never built from the contract (see Critical #2). Only reachable via test injection.
- **OK** Cross-rule dedup populates `also_violates` within trace only (cross-rule-dedup.ts:71); cross-stage is missing (Critical #3).

### Type State
- **OK** TS phantom-type inference present. `packages/backend-typescript/src/extractors/` includes type-state extractor (385 tests pass). Inference failure default = error: `packages/type-state-evaluator/src/evaluator.ts:352` `strictMode = options.strictMode ?? true`, lines 420-441 route inference_failed to violations when strict, notices otherwise — matches D-CG-1.
- **OK** `(type-state-binding …)` suppresses inference failure for the bound caller: `evaluator.ts:421-426`.
- **OK** Multi-source transitions `(from A B) (via cancel) (to C)`: `state-machine.ts:23-33` iterates `transition.from`.
- **OK** Cross-function propagation not implemented and honestly documented at `docs/design/phase-b/03-type-state.md:210-216`.
- **MINOR** `RULE_ID` constant for branded-id is `_RULE_ID` with leading underscore (`packages/type-driven-evaluator/src/branded-id-checker.ts:7`), suggesting it is dead/unused — verify it actually emits violations.

### Effect System
- **OK** Worklist + reverse postorder implemented exactly per MC-7: `packages/effect-evaluator/src/propagation.ts:69-115` (rev-postorder), `propagation.ts:235-305` (worklist with re-enqueue on change).
- **OK** Suppression is CDL-only: `packages/effect-evaluator/src/suppression.ts:20-22` comment + no source-annotation parser in extractor. `(reason …)` enforced at `packages/core/src/validator/structure-effect.ts:593-601` (E_MISSING_REASON).
- **OK** Unresolved fail-closed: `packages/effect-evaluator/src/evaluator.ts:196-218` widens effective set to ALL declared effects when `strictMode=true` (default).
- **NOT OK** `propagation chain depth cap = 5` (Round 2 E-P2-3) is **not implemented**. `propagation.ts:357-401` (`buildPropagationChain`) returns the BFS shortest path with no cap. `grep "depth.*5\|maxChain" packages/effect-evaluator/src/` returns nothing.
- **NOT OK** `direct_effects_on_node` vs `inherited_effects` are exposed via `PropagationEvidence` (effect-evaluator types) but the **render in the violation report** is just `renderEvidence(evidence)` lumped into `cause.detail`. There is no separate top-level field on `Violation` itself. Round 2 E-P0-3 wanted these to be first-class so agents can distinguish "add annotation" vs "delete call".

## Self-Protection Invariants Reality Check

| Invariant (contract/main.stele) | Verdict | Evidence |
|---|---|---|
| `ALL_EVALUATORS_COMPILE` (line 300) | **Partially enforces** | `contract/checker_impls/self_protection.py:1011-1054` correctly checks `dist/index.js` + `dist/index.d.ts` for all 5 packages. But removing any `dist/index.js` causes the CLI to crash on load **before** the checker runs (repro: `mv packages/trace-evaluator/dist/index.js …bak && node packages/cli/dist/index.js check` → `ERR_MODULE_NOT_FOUND`). So in practice this guards "I forgot to build" only when other packages still import fine. Not a real-world enforcement loop. |
| `STRICT_MODE_DEFAULT_IN_CI` (line 305) | **Enforces** | `self_protection.py:1057-1104` scans `.github/workflows/*.yml`. Directory exists (`ci.yml`, `publish.yml`). Looks for `--lenient-`. Tested: directory absent → pass; directory present with no flag → pass. The flag patterns it scans for (`--lenient-effects`, etc.) **don't exist as CLI options** (`grep "lenient-effects" packages/cli/src/` → 0 hits). It catches *future* drift, not current. |
| `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` (line 310) | **Enforces** | `self_protection.py:1148-1219` parses TS function bodies and asserts the 5 keywords. Verified `_FIX_HINT_SOURCES` covers all 3 files (line 1107-1111). Heuristic = "function starts with `default`" correctly skips `proposeExitText`. NOTE: invariant was renamed from `FIX_HINT_NOT_VAGUE` (FINAL-SPEC.md:141) to the stricter `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` (severity bumped warning → error). This is a tightening — fine, but undocumented in FINAL-SPEC. |

## fix-hint A/B Verification

All three `default*FixHint` functions checked manually:

| File | Function | `code issue` | `contract issue` | `propose` | `[A]` | `[B]` |
|---|---|---|---|---|---|---|
| `packages/trace-evaluator/src/fix-hint-substitution.ts:126` | `defaultFixHint` | yes (L141) | yes (L144) | yes (L148) | yes (L141) | yes (L144) |
| `packages/type-state-evaluator/src/fix-hint.ts:41` | `defaultDisallowedOpFixHint` | yes (L51) | yes (via proposeExitText L62) | yes | yes | yes |
| `packages/type-state-evaluator/src/fix-hint.ts:77` | `defaultInferenceFailedFixHint` | yes | yes | yes | yes | yes |
| `packages/effect-evaluator/src/fix-hint.ts:43` | `defaultForbiddenEffectFixHint` | yes | yes | yes | yes | yes |
| `packages/effect-evaluator/src/fix-hint.ts:84` | `defaultDisallowedEffectFixHint` | yes | yes | yes | yes | yes |
| `packages/effect-evaluator/src/fix-hint.ts:128` | `defaultUnresolvedCallFixHint` | yes | yes | yes | yes | yes |

All emit `contract/design/proposals/<id>.yaml` + `stele design propose` and explicitly say the type-specific subcommand "is a planned follow-up" (e.g. `fix-hint.ts:31`, `fix-hint-substitution.ts:148`, `type-state/fix-hint.ts:31`). Good honesty.

**Minor concern**: `packages/effect-evaluator/src/fix-hint.ts:10` (a comment, NOT user-facing) writes `\`stele design propose --effect-policy\`` — a flag that doesn't exist. Doesn't reach agent output but misleads future maintainers. Same kind of stale reference: `packages/effect-evaluator/src/fix-hint.ts:150` says "opt out with `--no-strict-effects`" in agent-facing text but **`--no-strict-effects` is not a registered CLI flag** (`grep "strict-effects" packages/cli/src/` returns 0). Honesty failure: agent will try the flag and get an error.

No helper functions bypass the A/B template — `proposeExitText` is a helper used INSIDE the templates, not an alternative to them.

## Documented Limitations Verification

- **`--strict-effects` / `--strict-trace` / `--strict-type-state` CLI flags** — not registered. `grep -rn "strict-effects\|strict-trace\|strict-type-state" packages/cli/src/` returns nothing. **However** the comment block in `effect-evaluator/fix-hint.ts:150` advertises `--no-strict-effects` to agents (not just maintainers). **This is a contradiction** — the spec was "no flag, granular strict is implicit by default" but the user-facing hint promises an opt-out that doesn't exist.

- **`stele design propose --trace-policy <id>`** — confirmed positional argument: `packages/cli/src/commands/design/index.ts:77` `cmd.argument("<type>", ...)` with allowed values `invariant, branded-id, aggregate`. No `--trace-policy` / `--effect-policy` / `--type-state` flags. Fix-hints correctly point to this and call out the gap.

- **Go/Java/Rust extractors deferred** — confirmed: `find packages/backend-{go,java,rust} -name "*extractor*"` returns 0. Only `packages/backend-typescript/src/extractors/call-graph.ts:39` provides `tsCallGraphExtractor`.

## Test Counts (vs maintainer's claimed numbers)

All ran cleanly. Numbers exactly match the maintainer's claims:

| Package | Maintainer claim | Measured |
|---|---|---|
| `@stele/core` | ~1309 | **1309 passed (43 files)** |
| `@stele/call-graph-core` | ~72 | **72 passed (3 files)** |
| `@stele/trace-evaluator` | ~89 | **89 passed (5 files)** |
| `@stele/type-state-evaluator` | ~73 | **73 passed (4 files)** |
| `@stele/effect-evaluator` | ~116 | **116 passed (7 files)** |
| `@stele/type-driven-evaluator` | ~31 | **31 passed (3 files)** |
| `@stele/backend-typescript` | ~385 | **385 passed (13 files)** |

`stele check` reports `OK 31 invariants` — matches.

## Phase A Regression Check

Phase A rule_ids intact:
- `packages/type-driven-evaluator/src/smart-ctor-checker.ts:10`: `const RULE_ID = "typedriven.shape.smart-constructor";`
- `packages/type-driven-evaluator/src/branded-id-checker.ts:7`: `const _RULE_ID = "typedriven.shape.branded-id";`
- Git history (`git log -S "typedriven.shape" --oneline`) shows the string predates Phase B (commit `9528503` introduces `typedriven.shape.smart-constructor`).

Convention `typedriven.{form}.{id}` (Round 2 D-CG-4) is honoured: "shape" is the form, "smart-constructor" / "branded-id" the id.

**Concern**: the leading underscore on `_RULE_ID` in `branded-id-checker.ts:7` is suspicious — typical TS convention for "intentionally unused". If branded-id-checker never actually emits a violation, the Phase A rule may be hollow. Worth a probe (out of my scope unless prioritized).

## Specific Fix List (prioritized)

1. **[P0] `packages/trace-evaluator/src/violation-builder.ts:68-70` + `evaluator.ts:46-291`** — implement `strictMode` (default true) in trace evaluator; route `path_exceeded_max_depth` to `violations` with severity=error when strict. Without this, D-CG-2 is broken and contracts silently lose coverage on deep call chains.

2. **[P0] `packages/effect-evaluator/src/fix-hint.ts:150`** — remove or replace the `--no-strict-effects` line. Either register the flag in `packages/cli/src/index.ts` (matching the spec's "no granular flags" decision needs to be honoured one way) or change the text to "if you accept the analysis gap, document a contract `(effect-suppression …)` for the affected node". Agents WILL try this flag.

3. **[P0] `packages/core/src/validator/`** — implement `parseExternAliasDeclaration` and wire `Contract.externAliases`. Then thread into `packages/cli/src/commands/check-stages-trace.ts:170-175` so production trace evaluation actually uses the registry. Today the entire `extern-alias` feature is a no-op for end users.

4. **[P1] `packages/cli/src/commands/check-stages-*.ts`** — after each evaluator returns, merge all stages' violations and run `annotateCrossRuleViolations` (or a new cross-stage equivalent) so `also_violates` works across `trace.*` / `effect.*` / `typestate.*`. Today the spec's "fix X, Y follows" UX is unrealized.

5. **[P1] `packages/effect-evaluator/src/propagation.ts:357-401`** — cap `buildPropagationChain` at 5 nodes per Round 2 E-P2-3; emit `[… N more callees, run \`stele explain effect <node>\` to see full]` when truncated. Long chains will flood agent context today.

6. **[P1] `packages/effect-evaluator/src/violation-builder.ts:163-173`** — expose `direct_effects_on_node` and `inherited_effects` as **top-level Violation fields** (the schema in `packages/core/src/report/types.ts` already supports extensions). Round 2 E-P0-3 wanted these structured, not flattened into `cause.detail`.

7. **[P2] `packages/effect-evaluator/src/fix-hint.ts:10`** — fix the comment `stele design propose --effect-policy` (flag doesn't exist). Cosmetic but rotting docs.

8. **[P2] `packages/type-driven-evaluator/src/branded-id-checker.ts:7`** — investigate the leading-underscore `_RULE_ID`. If the checker is wired and emits violations, rename to `RULE_ID`. If dead, delete the file or document.

9. **[P2] `contract/main.stele:310` + `FINAL-SPEC.md:141-144`** — FINAL-SPEC says `FIX_HINT_NOT_VAGUE (severity warning)`; ship has `FIX_HINT_REQUIRES_ANALYSIS_BRANCH (severity error)`. Update FINAL-SPEC to record the actual name/severity (it's a stricter check — fine, but un-tracked).

10. **[P2] `packages/core/src/report/types.ts:127,217,438`** — either remove `resolves_with` (currently dead — only test fixtures reference it) or populate it from a real cross-rule resolver. Schema field with no producer is rot.

---

Bottom line: the **three core mechanisms compile and pass tests as designed**, and the worklist / fail-closed / CDL-only-suppression safety choices were faithfully implemented. The gaps are real but bounded — they cluster around (a) the strict-mode story for the trace evaluator (P0), (b) `(extern-alias …)` end-to-end wiring (P0), and (c) cross-rule UX glue (P1). Self-protection invariants are honest about what they check; one of them (`ALL_EVALUATORS_COMPILE`) is structurally weak because the CLI crashes before it runs, but that's a defensible design given pnpm workspace semantics.
