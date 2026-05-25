# Self-Dogfooding 2026-Q2 — Summary

**Status:** Phase 7 docs landed 2026-05-25 (reviewer cycles still ahead)
**Plan dir:** [`docs/design/self-dogfooding/`](../design/self-dogfooding/)
**Coverage matrix:** [`self-protection-coverage-matrix.md`](self-protection-coverage-matrix.md)
**CDL spec:** [`docs/spec/cdl.md`](../spec/cdl.md)

## What changed

Stele advertises **14 contract mechanisms** but, before this plan, used
only **2** of them on its own source (`invariant` + a small `checker`
helper). The 2026-Q2 self-dogfooding plan closed that gap by adopting
every advertised mechanism against this repository's own TypeScript,
hook scripts, and design profile.

| | Before plan | After Phase 6 close-out |
|---|---|---|
| Mechanisms in use | 2 (`invariant`, `checker`) | **14** (all rows have ≥ 1 ✅) |
| Invariants in `contract/main.stele` | 35 | **48** |
| Non-invariant declarations | 0 | ~100 (matrix breakdown) |
| Negative tests (`contract/checker_impls/test_negative.py`) | 59 | **88** |
| Pytest `tests/contract/` | 35 | **48** |
| Branded-ID call-site coverage | 0 real sites | 5 brands × ~140 wrapped sites |
| Aggregate-root class-shapes | 0 | 1 landed + 9 deferred |

## Phase-by-phase ledger

Each phase landed one commit (or a small series) ending with
`Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`. The full
decision log lives in [`docs/design/self-dogfooding/README.md`](../design/self-dogfooding/README.md).

### Phase 0 — Multi-language config infrastructure

- **Landed:** `phaseLanguages` field in `stele.config.json` so Stele
  can run Phase B evaluators (trace / type-state / effect / code-shape /
  architecture) in `typescript` while keeping `targetLanguage: "python"`
  for the pytest runtime. Added `PHASE_LANGUAGE_CONFIG_VALID` invariant
  + checker + 2 negative tests.
- **Key decision:** kebab-case keys match the CDL mechanism names; the
  field is advisory unless a future release allows omitting per-
  declaration `(lang …)` markers.
- **Blocks unblocked:** Phases 3, 4, 5.

### Phase 1 — Branded IDs + smart constructors

- **Landed:** 5 brands (`RuleId`, `Sha256`, `ContractPath`,
  `CommandName`, `PackageName`) with paired smart constructors, plus 5
  self-protection invariants + checkers (`{RULE_ID,SHA256,CONTRACT_PATH,
  COMMAND_NAME,PACKAGE_NAME}_USES_BRANDED_TYPE`) and 5 negative tests.
  ~140 raw-string call sites wrapped via `ruleId(...)`, `sha256(...)`,
  `contractPath(...)`, `commandName(...)`, `packageName(...)`.
- **Key decision:** brands and smart-ctors are now declared in
  `contract/generated/ddd-typedriven.stele` (auto-generated from the
  DDD profile) — single source of truth for the type-driven facet.

### Phase 2 — Code-shape

- **Landed:** 2 `boundary` declarations (core-no-fs-write-from-non-manifest,
  cli-commands-no-direct-fs-write), 1 `class-shape` (`cli-command-error-
  shape`), 3 `function-shape` (`hook-fail-closed-v2`, `stop-validate-
  fail-closed`, `write-atomic-has-rename`), 1 `type-policy`
  (`no-any-in-core`), 1 `file-policy` (`hook-scripts-shebang`).
- **Source refactors needed:**
  - `CliCommandError.exitCode` promoted from parameter property to
    explicit field declaration (TS analyzer only collects
    `ts.isPropertyDeclaration` members).
  - `pre-tool-protect.js` top-level body wrapped in `async main()` so
    the `function-shape` selector has an anchor.
- **Key decisions:**
  - Code-shape IDs must start with lowercase letter (`RuleId` smart-
    ctor regex `^[a-z][A-Za-z0-9._:-]*$`); phase doc used UPPER_SNAKE,
    landed as `lowercase-kebab`.
  - `(deny-import "module::name")` is a no-op on the TS analyzer
    (Python analyzer emits both module and named import; TS only emits
    module specifier). Workaround: deny entire modules with
    `(allow-target …)`.
  - `(deny-call …)` matches only module-level calls in both languages
    (function-body call detection requires a `function-shape` selector).
  - `@stele/backend-python` renderer now skips `(lang typescript)`
    code-shapes (pre-fix it emitted pytest tests that tried to
    `ast.parse` `.ts` files).
  - TS analyzer extended to accept `.js` / `.mjs` / `.cjs` so hook
    scripts can be selectors.
- **Deferred to Phase 7 (3 contracts):** `MANIFEST_ENGINE_SHAPE`,
  `VIOLATION_REPORT_SHAPE`, `RULE_ID_FIELDS_BRANDED` — all target
  TypeScript type aliases, but `class-shape` evaluator only binds
  to real `class` declarations.
  **RESOLVED in Closeout 6 (2026-05-25):** all three landed. Manifest
  binds through public manifest barrel exports, violation reports bind
  through `createViolationReport` return-type alias resolution, and
  rule/report/notice IDs are enforced as branded `RuleId` fields.

### Phase 3 — Trace-policy

- **Landed:** 4 trace-policy declarations:
  - `FS_WRITES_VIA_WRITE_ATOMIC` — all `fs.writeFile` in `@stele/core`
    transit through `writeAtomic`
  - `CHECK_PREPARE_VIA_LOAD_CONTRACT` — `prepareCheckContextWithContract`
    must follow `loadContract` in `check.ts`
  - `GENERATE_VIA_COORDINATOR` — `writeAtomic` in `generate.ts` must
    follow `coordinateGeneration`
  - `APPROVE_VIA_RESOLVE_APPROVED_BY` — `writeFileSync` in `approve.ts`
    must follow `resolveApprovedBy`
  - 4 negative tests.
- **Key decisions:**
  - Re-grounded `trace-policy` semantics against the live evaluator:
    `target` is the path destination; `must-transit` checks
    intermediates; `must-be-preceded-by` checks edge order inside a
    single caller body.
  - External-package functions appear as `extern:<package>::…`
    (e.g., `extern:node-fs::writeFile`), not `node:<module>::…`.
  - Commander's `.action(fn)` is a property assignment, not a call
    edge — `runCheck`, `runGenerate`, `runDesignApprove` have no in-
    scope callers in the extracted graph. Rewrote 3 of the 6 phase-
    doc trace-policies as `must-be-preceded-by` over the caller body.
- **Deferred to Phase 7 (2 contracts):**
  - `EVALUATOR_VIA_EXTERN_REGISTRY` — DI seam through a local-
    variable holder prevents the extractor from drawing the edge.
  - `BACKEND_LOAD_VIA_REGISTRY` — intent is an import boundary; should
    be re-landed as a `(boundary …)` declaration.
  **RESOLVED in Closeout 6 (2026-05-25):** `buildTraceStage` now has
  direct ordered `buildExternAliasRegistry(...)` then
  `evaluateTracePolicies(...)` call-graph edges, and backend package
  imports are denied outside `packages/cli/src/backend-registry.ts`.
- **Perf baseline:** `stele check` went 11.0s → 13.8s (+2.8s, well
  inside the 30s budget).

### Phase 4 — Effect-policy

- **Landed (4.1 + 4.2):**
  - 1 `effect-declarations` block with 9 effect names (`fs.read`,
    `fs.write`, `time`, `random`, `env`, `network`, `crypto.hash`,
    `process`, `child-process`). `pure` deliberately omitted.
  - 13 JSDoc `@stele:effects` annotations across `@stele/core` source
    (`load-contract.ts`, `manifest.ts`, `hash-manifest.ts`,
    `file-walk.ts`, `baseline/io.ts`, `report/types.ts`).
- **Landed in follow-up commit `451a1d0` (Phase 4 final):**
  - 4 `effect-policy` declarations (`CORE_IS_PURE_OR_FS_READ`,
    `HOOK_NO_NETWORK`, `GENERATOR_NO_NETWORK_OR_CHILD_PROCESS`,
    `MANIFEST_LEAVES_ARE_PINNED`).
  - 3 `effect-suppression` declarations for the canonical atomic
    writers (`writeAtomic(2)`, `writeManifest(3)`, `writeHashManifest(2)`).
  - 4 negative tests for the 4 policies. Round 15 (commit `1423559`)
    found 2 dead-by-construction tests; both are now resolved:
    - `test_core_is_pure_or_fs_read_catches_random_in_core` — LIVE,
      truly asserts.
    - `test_manifest_leaves_are_pinned_catches_extra_effect` — LIVE,
      truly asserts.
    - `test_hook_no_network_catches_fetch_in_hook_script` —
      historical root cause: HOOK_NO_NETWORK targets `*.js` files but the TS
      call-graph extractor sets `allowJs: false`
      (`packages/backend-typescript/src/extractors/call-graph.ts:222`)
      and its directory walker only collects `.ts/.tsx` (line 269).
      **RESOLVED in Closeout 2 (2026-05-25):** hook scripts are visible
      to the analyzer and the negative test is live.
    - `test_generator_no_network_or_child_process_catches_execfile`
      — historical root cause: `target-scope` is a single file so a
      sibling drop can never satisfy it. Phase 7 follow-up: widen
      target-scope or rewrite using `_mutate_then_check` directly
      against `generate.ts`.
      **RESOLVED in Closeout 6 (2026-05-25):** target-scope now also
      covers `packages/cli/src/design-generator/**::*`; the execFile
      negative is live and a second fetch-shaped negative pins network
      effects.
  - **(historical, RESOLVED in Closeout 1, 2026-05-25)** —
    `effectStrictMode: false` set in `stele.config.json` to downgrade
    the ~1,454 unresolved-call sites (Commander dispatch, dynamic
    `await import()`) to advisory notices. **This was a policy
    degradation**, not a principled fix — see README decision log
    entry "effectStrictMode: false is a policy degradation". Filed
    as Phase 7 follow-up (Step 7.9: implement per-policy
    unresolved-call scoping), closed by Closeout 1.
- **Key decisions:**
  - Only leaf effect-producers in `@stele/core` are annotated; effects
    propagate through the call graph to downstream callers.
  - `deleteHashManifest` deliberately NOT annotated as a leaf
    `fs.write` (treated as cache eviction, not a manifest write).
- **Decision-log discrepancy** — the Phase 4 sub-agent's decision log
  entry says the 4 policies + 3 suppressions + 4 negative tests are
  **deferred**. They were subsequently landed in commit `451a1d0` and
  the decision log was not updated. This summary records the
  as-shipped state (policies/suppressions/tests are LIVE — but 2 of
  4 negative tests are skipped, per the bullet above).
- **Round 15 follow-up: vacuous-test bug.** Until Round 15 caught it,
  every Phase 4 negative test (and indeed all 88 negative tests in
  the file) used `return _helper(...)` instead of `assert _helper(...)`.
  pytest reported `passed` regardless of the helper's return value, so
  the entire Phase 4 negative-test layer was silently inert. Fixed in
  commit `1423559` — see "Open Phase 7 follow-ups" below.

### Phase 5 — Type-state

- **Landed:** 4 type-state lifecycles, each with state-keyed
  `StateBrand<S>` and a paired `.test-d.ts` file pinning 3
  `@ts-expect-error` sites (compile-time enforcement):
  - `MANIFEST_LIFECYCLE` (`Unloaded→Loaded→Locked→Verified`) —
    `packages/core/src/manifest/lifecycle.ts`
  - `APPROVAL_LIFECYCLE` (`Drafting→IdentityChecked→Signed`) —
    `packages/cli/src/commands/design/approval-lifecycle.ts`
  - `DESIGN_PROFILE_LIFECYCLE` (`Raw→Validated→Hashed`) —
    `packages/cli/src/design-profile/lifecycle.ts`
  - `CALLGRAPH_LIFECYCLE` (`Empty→Building→Built→Cached`) —
    `packages/call-graph-core/src/lifecycle.ts`
  - 4 negative tests (each mutates a `@ts-expect-error` pin, runs
    `pnpm --filter <pkg> typecheck`, asserts TS2345).
- **Key decision:** the type-state evaluator only binds to
  `receiver.method(...)` calls; production code uses free-function
  APIs (`writeManifest(...)`, `verifyManifest(...)`, `loadProfile(...)`,
  etc.), so the evaluator matches zero call sites today.
  Compile-time enforcement via `StateBrand<S>` is fully active;
  evaluator-time enforcement is **deferred to Phase 7** (~20-30
  call-site reroutes).
- **`packages/call-graph-core/tsconfig.json`** widened to include
  `tests/**` so `.test-d.ts` files participate in `typecheck`.

### Phase 6 — Aggregate-root class-shapes

- **Landed (commit `63958df`):** 1 of 10 aggregate-root class-shapes —
  `core-operator-registry-aggregate-shape` (target:
  `InMemoryOperatorRegistry`, `required_methods`: register/get/has/list,
  `required_fields`: `#operators`). The manually-written
  `operator-registry-shape` from Phase 2 was removed; single source of
  truth now lives in `contract/design/profile.yaml`.
- **Deferred (close-out commit `56b5d5e`):** 9 of 10 aggregates —
  `invariant-validator`, `contract-loader`, `manifest-engine`,
  `cli-check-orchestrator`, `cli-code-shape-evaluator`,
  `cli-design-diff-engine`, `cli-cli-program-factory`,
  `cli-design-profile-validator`, `architecture-architecture-evaluator`.
  Every one targets a free function, not a `class` declaration. The
  `class-shape` evaluator refuses to bind to non-classes (reviewer V-08).
  Each aggregate retains its `core-node` emission; only the optional
  class-shape pairing is absent.
- **Phase 6 infrastructure (commit `07967b9`):** `renderAggregateClass-
  Shape` gracefully handles the no-fields case — returns `undefined`
  so the renderer emits the `core-node` alone, byte-identical to
  pre-Phase-6 output.

### Phase 4 regressions discovered + fixed during Phase 6

Three regressions were introduced by the Phase 4 final commit
(`451a1d0`) and fixed in dedicated follow-up commits during Phase 6:

1. **`writeAtomic` lost its atomic rename.** `await rename(tmpPath,
   targetPath)` had been changed to `await writeFile(targetPath,
   content)`, neutralising the atomic temp-file dance and breaking the
   `write-atomic-has-rename` function-shape + the
   `FS_WRITES_VIA_WRITE_ATOMIC` trace-policy. Fix: commit `8458bc3`.
2. **`observation-hook.js` lost its `#!/usr/bin/env node` shebang** —
   silently broke the Phase 2.5 `hook-scripts-shebang` file-policy.
   Fix: commit `e88e23f`.
3. **Golden snapshot `render-stele.golden.stele` not updated** for
   Phase 4's tsconfig widening — caught when the Phase 6 sub-agent
   ran the design generator; the regenerated snapshot was rolled
   into the Phase 6 partial commit (`63958df`).

**Root cause for all three:** the Phase 4 sub-agent took the
silencing-by-edit anti-pattern (modify source until the contract
stops firing) instead of accepting the failure or going through the
propose/approve flow. The fix in every case was to restore the
original code; the contracts were correct. Future sub-agent prompts
must explicitly forbid editing source files to make a CDL rule pass.

## Final tally

```
$ node packages/cli/dist/index.js list | wc -l
49                             # = 48 invariants + 1 header row

$ grep -c "^def test_" contract/checker_impls/test_negative.py
88

$ .venv/bin/python -m pytest tests/contract -q   # 48 passed in 3.34s
$ .venv/bin/python -m pytest contract/checker_impls/test_negative.py -q
  88 passed in 477.06s (0:07:57)

$ node packages/cli/dist/index.js check    # 1 known error remaining
[error] trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth
```

Declarations by mechanism (live, derived from `contract/main.stele` +
`contract/generated/ddd-typedriven.stele`):

| Mechanism | Count | Source |
|---|---|---|
| invariant | 48 | main.stele |
| checker | 48 | main.stele |
| boundary | 2 | main.stele |
| class-shape | 2 | main.stele (1) + generated (1) |
| function-shape | 3 | main.stele |
| type-policy | 1 | main.stele |
| file-policy | 1 | main.stele |
| trace-policy | 4 | main.stele |
| effect-declarations | 1 | main.stele |
| effect-policy | 4 | main.stele |
| effect-suppression | 3 | main.stele |
| type-state | 4 | main.stele |
| branded-id | 5 | generated |
| smart-ctor | 5 | generated |
| architecture | 18 | generated |
| core-node | 10 | generated |

Pre-existing `stele check` error count: 1 (the same trace depth-cap
error noted in every phase log since Phase 4).

## Deferred items — consolidated list

Tracked here so Phase 7 (Round 15+ reviewer rounds) and subsequent
work can pick them up.

### Phase 2 deferrals (3)
- `MANIFEST_ENGINE_SHAPE` (class-shape on TS type alias)
- `VIOLATION_REPORT_SHAPE` (class-shape on TS type alias)
- `RULE_ID_FIELDS_BRANDED` (type-policy on TS type alias)

> **RESOLVED in Closeout 6 (2026-05-25).** These landed through the
> TypeScript analyzer/evaluator path: manifest barrel aggregate members,
> report return-type alias binding, and branded `rule_id: RuleId` fields.

### Phase 3 deferrals (2)
- `EVALUATOR_VIA_EXTERN_REGISTRY` (trace through local-var-held
  imported function — extractor limitation)
- `BACKEND_LOAD_VIA_REGISTRY` (re-land as `(boundary …)` with
  `deny-import "@stele/backend-*"`)

> **RESOLVED in Closeout 6 (2026-05-25).** `EVALUATOR_VIA_EXTERN_REGISTRY`
> landed via direct ordered trace-stage calls; `BACKEND_LOAD_VIA_REGISTRY`
> landed as a TypeScript boundary with backend imports centralized in
> `backend-registry.ts`.

### Phase 5 deferrals (system-wide)
- Route ~20-30 production call sites through the typed lifecycle
  methods (`asLoaded` / `lockManifest` / `verifyLockedManifest`,
  `markProfileValidated` / `hashValidatedProfile`,
  `attachApprovedBy` / `signApproval`, `startBuilding` /
  `finalizeCallGraph` / `cacheCallGraph`). Today the evaluator
  matches zero call sites.
- Add `type-state-binding` declarations once the upstream refactor
  lands (meaningful only once typed callers exist).

> **RESOLVED in Closeout 4 (2026-05-25).** 24 production call sites
> routed through typed lifecycle methods (MANIFEST 4, APPROVAL 1,
> DESIGN_PROFILE 15, CALLGRAPH 4). 4 `type-state-binding` declarations
> added to `contract/main.stele` (one per lifecycle, pinning the
> typed consumer's param 0 to the lifecycle's terminal state). The
> type-state evaluator was extended with a new rule
> `typestate.<LIFECYCLE>.wrong_state_at_binding` to fail closed when a
> binding's declared state disagrees with the static inference for
> the same param. 8 paired negative tests (CC-13 different shape)
> cover both enforcement layers (tsc + runtime evaluator). See
> [`docs/design/self-dogfooding-closeout/closeout-4-callsite-inventory.md`](../design/self-dogfooding-closeout/closeout-4-callsite-inventory.md)
> for the call-site checklist.

### Phase 6 deferrals (9)
Wrap each free-function aggregate in a stateless service class **or**
extend the TS class-shape extractor to bind module-level functions.
Affected aggregates:

| Aggregate | target |
|---|---|
| `invariant-validator` | `.../validator/structure-invariant.ts::validateInvariant` |
| `contract-loader` | `.../loader/load-contract.ts::loadContract` |
| `manifest-engine` | `.../manifest/hash-manifest.ts::hashManifest` |
| `cli-check-orchestrator` | `.../commands/check.ts::runCheck` |
| `cli-code-shape-evaluator` | `.../code-shape/evaluate.ts::evaluateCodeShapes` |
| `cli-design-diff-engine` | `.../commands/design/diff.ts::computeDesignDiff` |
| `cli-cli-program-factory` | `.../cli/src/index.ts::createSteleProgram` |
| `cli-design-profile-validator` | `.../design-profile/validate.ts::validateProfile` |
| `architecture-architecture-evaluator` | `.../architecture-core/src/evaluate.ts::evaluateArchitecture` |

**RESOLVED in Closeout 3 (2026-05-25, commits `8158af6` + `123ed56` +
`225deee` + `694972a` + `310dd07`).** Closeout 3 chose path 2 — the TS
class-shape evaluator gained first-class module-function and factory
binding (3a) and all 9 free-function aggregates were populated with
real `required_methods` / `required_fields` / `aggregate_members`
against the live source (3b). Targets that previously pointed at
re-export aliases (`validateInvariant`, `hashManifest`,
`createSteleProgram`) were switched to the underlying function
declaration names; the aliases survive in source. 18 new paired
negative tests (2 per aggregate, structurally different per CC-13)
plus the operator-registry's pre-existing 2 = 20 negative tests on
aggregate class-shapes.

### Phase 4 deferrals (long-term effect-evaluator improvements)
- Per-policy scoping for unresolved-call emission in
  `@stele/effect-evaluator` (skip `buildUnresolvedCallViolation` for
  `fromId` nodes outside any policy's `target-scope`).
  **RESOLVED in Closeout 1 (2026-05-25):** the evaluator now gates
  emission on per-policy `target-scope` membership; out-of-scope
  unresolved calls emit nothing. Source-annotated nodes are treated
  as closed-world (author's effect declaration overrides analyzer
  uncertainty).
- Or: configurable per-policy severity in `stele.config.json`.
  Today's workaround was a global config flag.
  **RESOLVED in Closeout 1 (2026-05-25):** no new knob added; severity
  is unconditionally `error` for in-scope unresolved calls. The
  workaround flag was deleted everywhere.

## Open Phase 7 follow-ups

1. **1 known `stele check` error remains** —
   `trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth`. The
   trace evaluator hits its default max-depth cap when walking back
   from `extern:node-fs::writeFile` through the cached call graph.
   Was already firing when Phase 5 began. Fix options:
   (a) raise `maxDepth` for this policy, (b) narrow `(scope …)`,
   (c) intermediate caching of partial paths in the evaluator.
   **RESOLVED in Closeout 5 (2026-05-25):** picked option (c) —
   added depth-tagged negative partial-path memoization to
   `@stele/trace-evaluator`. The exhaustive-walk dump at
   `docs/design/self-dogfooding-closeout/closeout-5-exhaustive-walk.md`
   proves Case (A): the cap was hiding a legitimate "no violation"
   conclusion (no simple path from `loadContract` reaches
   `writeFile` at all). `maxDepth=10` default preserved; the
   policy now has 2 paired CC-13 negative tests of different shape.
2. **9 aggregate-root class-shapes** — see the table above.
3. **Type-state evaluator binds zero call sites** — see Phase 5
   deferrals.
4. **Phase 2 type-alias targets** — `MANIFEST_ENGINE_SHAPE`,
   `VIOLATION_REPORT_SHAPE`, `RULE_ID_FIELDS_BRANDED`.
   **RESOLVED in Closeout 6 (2026-05-25):** the TS code-shape/type-policy
   path now binds these surfaces without migrating them to classes.
5. **Decision-log freshness** — the Phase 4 sub-agent's decision-log
   entry says effect-policies were deferred; commit `451a1d0`
   subsequently landed them. The decision log is appended-only by
   convention; Phase 7 reviewer rounds should reconcile log entries
   against the as-shipped state.
6. **Reviewer rounds — Round 15 + Round 16 complete (2026-05-25).**
   Round 15 (independent auditor T) returned 3 HIGH + 1 MED. The 3
   HIGH findings were fixed in commit `1423559`:
   - Vacuous-test bug (all 88 tests used `return` instead of
     `assert`; pytest reported all PASSED regardless of helper return
     value). 82 mechanical assert-conversions + a `pyproject.toml`
     `filterwarnings = ["error::pytest.PytestReturnNotNoneWarning"]`
     to prevent regression.
   - 2 effect-policy rule_id case mismatches corrected.
   - 2 dead-by-construction tests properly marked `@pytest.mark.skip`.
   Round 16 (regression hunter) returned 0 HIGH + 2 MED + 4 LOW. The
   MEDs were doc-tracking gaps (this section + Step 7.9 below) and
   are addressed in commit `<round-16-fix-sha>`. CC-10 is satisfied
   by these two rounds; a Round 17 may still be valuable but is not
   blocking.
7. **HOOK_NO_NETWORK policy is dead by construction.** Targets `*.js`
   files but the TS call-graph extractor sets `allowJs: false`
   (`packages/backend-typescript/src/extractors/call-graph.ts:222`)
   and its directory walker only collects `.ts/.tsx` (line 269). Fix
   options: (a) enable `allowJs` in the extractor (broader
   call-graph scope; needs perf review), or (b) migrate hook scripts
   to `.ts` with a transpile step. Until one of these lands the
   policy is documentation, not enforcement, and the paired negative
   test stays `@pytest.mark.skip`-ed. See README decision log entry
   "HOOK_NO_NETWORK policy is dead by construction".
8. **`effectStrictMode: false` is a policy degradation** that traded
   1,454 unresolved-call errors for warnings to keep the 4 Phase 4
   effect-policies green. Principled fix: implement per-policy
   unresolved-call scoping in `@stele/effect-evaluator` (emit
   unresolved-call errors only for nodes inside a policy's
   `target-scope`), then remove the knob from `stele.config.json`.
   **RESOLVED in Closeout 1 (2026-05-25).**
   See README decision log entry "effectStrictMode: false is a
   policy degradation, not a fix".

## Reading order for future maintainers

1. [`README.md`](../design/self-dogfooding/README.md) — the plan +
   cross-cutting rules (CC-1 ... CC-11) + the full decision log.
2. [Coverage matrix](self-protection-coverage-matrix.md) — what's
   actually exercised today.
3. [Phase docs 0-7](../design/self-dogfooding/) — per-phase
   intent and acceptance criteria.
4. [`docs/spec/cdl.md`](../spec/cdl.md) — authoritative semantics
   for every mechanism listed above.
5. `contract/main.stele` + `contract/generated/ddd-typedriven.stele`
   — the live contracts.
