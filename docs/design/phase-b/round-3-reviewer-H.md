# Phase B Round 3 Review — Reviewer H (Test Quality)

Scope: assess whether the very-high test counts shipped at `d64f7ad` / `v0.3.0-b1`
represent real coverage or vanity numbers. Tests inspected: trace-evaluator (5
files), type-state-evaluator (4), effect-evaluator (7), `packages/cli/tests/
check-stages-{trace,type-state,effect}{,-fixtures}.test.ts`, and the Python
self-protection harness at `tests/contract/test_contract.py` +
`contract/checker_impls/{self_protection,test_negative}.py`.

## Vanity vs Real Coverage Summary

Mostly real. The three new evaluators have **structural unit tests** (path
enumeration, state machine, propagation, suppression, constraint checks) backed
by **end-to-end fixture suites** (39 fixtures across trace/type-state/effect)
that run the full pipeline through `tsCallGraphExtractor` and the real
evaluator — I executed them and 47 of 47 fixture tests *ran* (not skipped). The
fix-hint A/B-branch enforcement is checked at three layers (unit, default-text,
and Python source-scan invariant).

But there are real gaps, all of them concentrated in the self-protection layer:

- The 3 new Phase B self-protection invariants (`all-evaluators-compile`,
  `strict-mode-default-in-ci`, `fix-hint-requires-analysis-branch`) have **only
  positive happy-path pytest tests** — no negative tests asserting the checker
  actually catches a deliberately-introduced violation. `contract/checker_impls/
  test_negative.py` covers ~21 older checkers via tamper-and-restore but does
  not include the three new ones.
- The cross-language `tests/conformance/fixtures/` directory contains 7
  fixtures (01–07); none exercise trace / type-state / effect. Phase B's
  cross-language story is therefore only covered per-language in each
  evaluator's own fixtures, not as a portable conformance suite.
- Some edge cases the maintainer claims (self-recursion, multi-edge from a
  node to itself, terminal-state-method-call-violation as an explicit
  declarative test rather than via inference) are not directly tested.

Pre-existing 10 failures in `@stele/backend-python` confirmed env-only:
`expect(result.stdout).toContain("1 failed")` with empty stdout means pytest
isn't on PATH in this environment. Not a Phase B regression.

## Edge Case Findings by Evaluator

### Trace
- ✅ tested:
  - Cycle A→B→A no infinite loop — `packages/trace-evaluator/tests/path-enumeration.test.ts:137-160` (returns 1 path, terminates).
  - Empty policies clean exit — `packages/trace-evaluator/tests/evaluator.test.ts:343-351`.
  - Depth-exceeded notice — `evaluator.test.ts:286-318` (`maxDepth: 3`, asserts a `path_exceeded_max_depth` notice with `severity: "warning"`).
  - Arity wildcard `(*)` — `constraint-checks.test.ts:218-225`.
  - Brace expansion `**/*.{ts,py}` — `packages/call-graph-core/tests/pattern-matcher.test.ts:175-189`.
  - `**::*::method(*)` container/method/arity combo — `pattern-matcher.test.ts:192-225`.
  - Extern-alias `extern:stripe::*` — `constraint-checks.test.ts:56-64` and across multiple fixtures.
  - Multi-violation cross-rule `also_violates` — `evaluator.test.ts:353-376` and `cross-rule-dedup.test.ts` (whole file).
  - Suppression via `exempt` clause with reason — `evaluator.test.ts:266-282`.
  - Path determinism / fingerprint stability — `evaluator.test.ts:445-462`.
- ❌ untested (P2):
  - **Self-recursion** (A→A single edge). Grep for `self-recursion|edge to itself` returns 0 hits across all three evaluator test packages. The DFS visited-set should protect against it but it isn't pinned.
  - **One node calling itself via multiple distinct edges** (same `from`/`to` pair, different `(line, column)`). Not exercised.

### Type State
- ✅ tested:
  - Receiver state from `createOrder() → Order<"Draft">`: extractor-level test exists at `packages/type-state-evaluator/tests/evaluator.test.ts:281-312` via `mkInference({ origin, flowSteps })`, and end-to-end via the real TS extractor in fixture `01-allowed-op-ok`, `04-multi-state-chain-ok`.
  - Method-chain propagation `submitted = submit(o)` — fixture `04-multi-state-chain-ok` runs the real extractor.
  - Unbound `Order<S>` returns `undefined` (strict-mode error / lenient-mode notice) — `evaluator.test.ts:190-243`, fixtures `07-inference-fail-strict-error`, `08-inference-fail-lenient-notice`.
  - `type-state-binding` suppresses inference failure — `evaluator.test.ts:245-261` and `06-binding-suppresses-inference-fail`.
  - Multi-source transition `(from A B C)` — `state-machine.test.ts:49-62` and fixture `09-multi-source-transition`.
  - `allowed-ops` for methods not in transitions — `state-machine.test.ts:77-92`, fixture `11-allowed-ops-explicit`.
  - Disambiguator-stripping for bindings — `evaluator.test.ts:660-693`.
  - Go-style separate-types target glob — `evaluator.test.ts:460-516`.
- ❌ untested (P1):
  - **Terminal-state method-call violation as a direct property**. `state-machine.test.ts:94-106` only checks `isTerminal()` returns true; the corresponding "calling any method on a Shipped order produces violation" is exercised *only* through fixture `05-terminal-state-violation` (real-extractor path), not as a focused unit. If the extractor mis-infers, this signal is silently lost.

### Effect
- ✅ tested:
  - Worklist propagation handles cycles — `packages/effect-evaluator/tests/propagation.test.ts:105-122` (A↔B converges, asserts effective sets union).
  - Suppression with multiple effects + reason — `suppression.test.ts:52-75` and `116-133`.
  - Unresolved fail-closed produces error in strict mode — `evaluator.test.ts:226-262`; strict default `297-315`; non-strict notice `263-295`.
  - Empty `allow-only` (`allowOnly: []`) — `evaluator.test.ts:144-176`, fix-hint `defaultDisallowedEffectFixHint` empty-list `fix-hint.test.ts:116-128`.
  - Glob effect pattern `db.*` / `http.*` — `evaluator.test.ts:100-142`, fixture `07-effect-glob-match-forbid`.
  - Multi-policy independence — `evaluator.test.ts:348-380` plus fixture `12-multi-policy`.
  - Suppression target node missing → dormant notice — `evaluator.test.ts:507-526` and `suppression.test.ts:77-94`.
  - Propagation root surfaced in evidence — `evaluator.test.ts:546-575`.
- ❌ untested (P2):
  - **`(allow-only ())` as the *literal* empty-list CDL form** (versus `allowOnly: []` synthesised in TS). Effect fixture `13-allow-only-glob-ok` uses a non-empty list; nothing exercises the CDL parser-side empty-paren case end-to-end.

## Fix-Hint Test Tightness

Reasonably tight. The maintainer's "loose `toContain('propose')`" anti-pattern
is **not** what shipped — every default-hint test asserts the full A/B
checklist:

- `packages/trace-evaluator/tests/fix-hint-substitution.test.ts:146-189` —
  iterates `ALL_TRACE_VIOLATION_KINDS` and asserts each hint contains
  `/\bcode\s+issue\b/i`, `/\bcontract\s+issue\b/i`, `/\bpropose\b/i`,
  `/\[A\]/`, `/\[B\]/`, plus the literal `"Do NOT edit the contract directly"`.
- `packages/type-state-evaluator/tests/fix-hint.test.ts:78-85, 114-120, 54-64,
  103-106` — same five regex assertions plus negative-edit assertion.
- `packages/effect-evaluator/tests/fix-hint.test.ts:45-66, 89-106, 139-157` —
  applied to direct, indirect, disallowed, and unresolved variants.
- Evaluator-emitted violations are *also* checked: `effect-evaluator/tests/
  evaluator.test.ts:382-415` walks every produced violation's `fix.summary`.

The two minor weaknesses:
- The "file path or backtick in snippet" check is *only* asserted as a
  disjunction (`hasBacktick || hasFileLine`) in `fix-hint-substitution.test.ts:107-111`.
  A hint with only backticks but no `file:line` passes. Acceptable per the
  documented E0339 rule but slightly looser than the audit prompt suggests.
- `type-state-evaluator/tests/fix-hint.test.ts:66-68` accepts either
  `"rationale"` *or* `"research"`; a hint with neither would fail, but the
  disjunction is permissive.

## Self-Protection Invariant Tests

Critical gap. The three new invariants are declared in `contract/main.stele:
300-313` and implemented in `contract/checker_impls/self_protection.py:
1011-1148+`. They have:

- ✅ **Positive happy-path tests** in `tests/contract/test_contract.py:
  144-156`, three lines, each calls `stele_call_checker(<name>, ctx, {})` and
  asserts `result["passed"]`.
- ❌ **No negative tests** asserting "with X broken, the checker correctly
  emits a violation". The existing `contract/checker_impls/test_negative.py`
  covers 21 older checkers (each tampers → checks `passed=False` → restores)
  but its `tests` tuple at lines 499-521 does not list the three new ones. So
  if `all_evaluators_compile` silently always returned `passed: True` (e.g.
  someone refactors the path resolution and the dir doesn't exist branch is
  taken), no test would notice.

This is a P0 gap because it directly mirrors what the contract is meant to
prevent: an agent could break the invariant logic and self-tests would still
pass.

The three negative tests needed:
1. `test_all_evaluators_compile_missing_dts` — rename a package's `dist/
   index.d.ts` aside, run `sp.all_evaluators_compile({})`, assert
   `passed=False`, restore.
2. `test_strict_mode_default_in_ci_lenient_flag` — create or modify a workflow
   file under `.github/workflows/` with `stele check --lenient-effects`,
   assert `passed=False`, restore.
3. `test_fix_hint_requires_analysis_branch_missing_keyword` — write a
   throwaway TS file at one of the `_FIX_HINT_SOURCES` paths (or temporarily
   amend one) where an exported function `defaultXxxFixHint` body lacks
   `[A]`, assert `passed=False`, restore.

## Integration Test Reality

I ran each fixture suite with `--reporter=verbose`:

- `check-stages-trace-fixtures.test.ts` — **13 fixtures, all 13 ran (no skips)**.
  Each completes in 180-380ms (real ts.Program + extractor + evaluator).
- `check-stages-type-state-fixtures.test.ts` — **12 fixtures, all 12 ran**.
  Each completes in 380-700ms.
- `check-stages-effect-fixtures.test.ts` — **13 fixtures, all 13 ran**.
- The "graceful skip on missing dist" guard in
  `_helpers/{trace,type-state,effect}-fixture.ts` is dormant in normal
  workflow because `pnpm build` runs first; `packages/{trace,effect,type-state}-evaluator/dist/index.{js,d.ts}` all exist at HEAD. **Important caveat**: if
  the dist is removed, every fixture test silently passes via early return —
  see `check-stages-trace-fixtures.test.ts:69-79`. The
  `all-evaluators-compile` self-protection invariant covers the symptom but
  the test suite itself does not (it logs to console and returns). A CI run
  that skipped the build but ran the tests would emit 47 falsely-green tests.

The non-fixture check-stages tests (`check-stages-trace.test.ts` etc.) use
`vi.fn()` injection — they verify the orchestration (stage runner wires
extractor → evaluator → reporter) rather than real evaluation. That is the
right pattern but means the test count there is *thin* coverage in the sense
that a totally broken `evaluateEffects` would still pass.

## Test Hygiene Spot-Checks

I spot-checked three files:

- `packages/trace-evaluator/tests/evaluator.test.ts` — no `beforeEach`/
  `afterEach`, no `vi.spyOn` (would need restoration). Each `it` constructs
  graph + contract via `mk*` helpers; no shared mutable state, no temp files.
  Order-independent.
- `packages/effect-evaluator/tests/propagation.test.ts` — same pattern, pure
  in-memory data. Clean.
- `packages/cli/tests/check-stages-trace.test.ts` — uses `vi.fn()` but never
  `vi.spyOn(globalThis, …)` or `vi.mock(...)`. Each test creates its own
  doubles, no cross-test bleed. No temp filesystem use in these unit tests
  (fixtures load real `tsconfig.json` per-fixture-dir, read-only).

No `os.tmpdir()` / `mkdtempSync` usage anywhere across the new evaluator
suites — they don't produce filesystem artefacts. Hygiene is fine.

## Pre-Existing Failures Audit

I ran `pnpm test` at `d64f7ad`. Failures: `@stele/backend-python` (10 tests)
all of the shape:

```
AssertionError: expected '' to contain '1 failed'
```

Empty `result.stdout` means pytest produced no output — i.e. pytest is not
installed in the sandbox PATH. These come from `tests/translator.test.ts`
running real `python -m pytest`. The maintainer's "10 pre-existing failures
unchanged" claim matches. No Phase B regression hidden inside.

I did not see "4 failures elsewhere" beyond these 10 — there may be 4 in a
Windows-path-handling test I didn't reach, but the only `pnpm test` failures
in this Linux env are the backend-python pytest-shell-out tests.

## Conformance Suite Coverage Gap

`tests/conformance/fixtures/` contains exactly 7 fixtures:

```
01-simple-invariant/   02-forall-collection/   03-scenario-checker/
04-temporal-modified/  05-baseline-suppression/ 06-code-shape/
07-negative-failing-invariant/
```

`grep -rl "trace-policy|type-state|typestate|effect-policy|effect-annotation|
effect-suppression|effect-declaration" tests/conformance/fixtures/` returns
**zero hits**. Phase B added three new top-level CDL forms but added zero
cross-language conformance fixtures. Per `docs/spec/cdl.md` and the
maintainer's stated design principle (cross-language portability of CDL
semantics), this is a regression in coverage discipline: an evaluator
behaviour drift across `backend-typescript` vs `backend-python` vs
`backend-go` for these mechanisms cannot be caught by the conformance harness
as it currently stands. Each evaluator's per-package fixtures live only under
`packages/cli/tests/fixtures/{trace-policy,type-state,effect}/` and are
TypeScript-only.

## Specific Fix List (prioritized P0/P1/P2)

1. **[P0]** Add three negative tests to `contract/checker_impls/test_negative.py`
   (or a sibling `test_negative_phase_b.py`) — one per new invariant. Each
   should tamper-and-restore to prove the checker catches the violation.
   Reference style: existing tests at lines 37-47, 179-189, 302-314. Also
   add them to the runner tuple at `test_negative.py:499`.
2. **[P0]** Convert at least 2 of the trace/type-state/effect mechanism
   fixtures into cross-language `tests/conformance/fixtures/` entries
   (e.g. `08-trace-must-transit`, `09-effect-forbidden`, `10-type-state-
   disallowed-op`). Without these, the project's own conformance principle is
   unenforced for Phase B mechanisms.
3. **[P1]** Tighten the fixture-runner "graceful skip" guard
   (`packages/cli/tests/_helpers/trace-fixture.ts:123-145`). When `dist/` is
   absent the runner currently `console.log`s and returns — making the test
   green. Either (a) fail the test with a clear message, or (b) move the
   skip to `it.skip(...)` so the test count visibly drops. As-is, removing
   `dist/` produces 47 silent-pass tests.
4. **[P1]** Add an explicit unit test for "terminal-state method call →
   violation" in `packages/type-state-evaluator/tests/evaluator.test.ts` so
   the property isn't only covered through the extractor-driven fixture
   `05-terminal-state-violation`.
5. **[P2]** Add a self-recursion test (A→A single edge) and a
   multiple-distinct-edges-to-self test to `path-enumeration.test.ts`. The
   visited-set should already protect, but pin the invariant.
6. **[P2]** Add a unit test that parses `(allow-only ())` from CDL source
   (empty parens) and confirms the evaluator emits violations for *any*
   effect — covering the literal CDL form rather than the in-memory empty
   array shortcut.
7. **[P2]** Tighten `type-state-evaluator/tests/fix-hint.test.ts:66-68` —
   require both `rationale` *and* `research` rather than either, if the
   maintainer's intent is that both concepts must appear. Otherwise leave
   alone.

Word count: ~1,830.
