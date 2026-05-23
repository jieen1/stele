# Reviewer F — Known unfixed issues catalog (2026-05-23)

Comprehensive backlog of every documented but unfixed issue as of HEAD
`484bc7f` (post Round 3 P0 + P1 closure). Conducted by an isolated
sub-agent with instructions to cross-reference each finding with the source.

## Bucket A — security / correctness (must fix)

### F-A-01 `(extern-alias …)` runtime API comment is stale

**Source**: `packages/effect-evaluator/src/fix-hint.ts:10`
**Description**: Module-level doc comment still advertises
`stele design propose --effect-policy`. That flag does not exist. Agent-facing
text was fixed (P0-7) but the maintainer-facing comment was missed.
**Fix**: Replace with `stele design propose <type>` and the YAML workflow.

### F-A-02 Non-TypeScript projects silently pass Phase B checks (fail-open)

**Source**: `packages/cli/src/commands/check-stages-trace.ts:88-104`,
`check-stages-type-state.ts:100`, `check-stages-effect.ts:85-109`
**Description**: When `targetLanguage` is anything other than `"typescript"`,
all three stages return `ok: true` with a single `warning` advisory.
Adopters on Python/Go/Rust/Java today silently pass mechanisms that should
block them.
**Fix**: Upgrade severity to `error` + `ok: false`, OR refuse at parse time
when contract declares mechanism the target language cannot enforce.

### F-A-03 `stele explain effect` lenient mode unflagged

**Source**: `packages/cli/src/commands/explain.ts:446-449`
**Description**: `inspectEffectNode` explicitly skips strict-mode widening
"because explain is read-only". An agent researching a violation via
`stele explain effect` sees a different effect set than the check reported.
**Fix**: Add `--strict` flag or always render both views with a footer.

### F-A-04 `_RULE_ID` dead in branded-id-checker

**Source**: `packages/type-driven-evaluator/src/branded-id-checker.ts:7`
**Description**: `const _RULE_ID = "typedriven.shape.branded-id"` with the
underscore-prefix and `eslint-disable no-unused-vars`. If the checker is
wired and emits violations, rename it; if dead, delete.
**Fix**: Audit + delete or wire.

### F-A-05 `resolves_with` is a schema field with no producer

**Source**: `packages/core/src/report/types.ts:127,217,250,482`
**Description**: Declared, normalized, round-tripped, but no evaluator
populates it. Only test fixtures reference it.
**Fix**: Either delete from `report/types.ts` and tests, or wire in
`annotateCrossRuleViolations`.

### F-A-06 `stele design generate` provenance lacks `trace-policy` kind

**Source**: `packages/cli/src/design-generator/ddd.ts:131-140`
**Description**: Inline comment: "Provenance entries for trace-policies are
intentionally NOT added here". `ProvenanceRule.kind` union doesn't accept
`trace-policy`/`type-state`/`effect-policy`.
**Fix**: Widen the union in `manifest.ts` and emit entries in
`renderTraceSection`.

### F-A-07 `stele design propose <type>` missing Phase B mechanisms

**Source**: `packages/cli/src/commands/design/index.ts:77`
**Description**: Argument doc: "type of proposal: invariant, branded-id,
aggregate". Phase B added three new top-level CDL forms and the fix-hints
in all three evaluators tell agents to use the YAML proposal workflow.
But `propose` only recognises three legacy kinds.
**Fix**: Extend allowed `<type>` set to include `trace-policy`,
`type-state`, `effect-policy`, `effect-suppression`.

### F-A-08 `--strict-*` / `--lenient-*` CLI flags don't exist

**Source**: `packages/cli/src/index.ts:141` (only `--lenient` for code-shape)
**Description**: `STRICT_MODE_DEFAULT_IN_CI` scans for `--lenient-` but no
such option is registered. The spec says these are deferred — so the
invariant currently catches drift in a future API.
**Fix**: Either implement the granular flags so the invariant has bite, or
remove the invariant and the spec mention until they land.

### F-A-09 Phase B contract not dogfooded

**Source**: `contract/main.stele` — verified
`grep -cE '^\(trace-policy|^\(type-state |^\(effect-' contract/main.stele` → 0
**Description**: Stele ships three new mechanisms and zero instances on its
own code. `post-phase-b-status.md:42-62` calls this the *most severe* P0
of the post-phase-b backlog.
**Fix**: Add 5-10 trace-policy / effect-policy declarations covering
Stele's own critical paths.

### F-A-10 Continue.dev adapter is a stub

**Source**: `packages/agent-hooks/src/adapters/continue-dev.ts:19-47`
**Description**: All four adapter methods throw `E_AGENT_NOT_IMPLEMENTED`.
CLI prints "Phase 3 candidate and not yet implemented."
**Fix**: Out of scope unless Phase 3 is prioritized.

## Bucket B — coverage gaps (should fix)

### F-B-01 P2-4: self-recursion (A→A) not unit-tested in path-enumeration

**Fix**: Add `it("handles A→A self-recursion")` and
`it("handles multiple distinct edges from node to itself")`.

### F-B-02 P2-5: literal CDL `(allow-only ())` empty-parens form not exercised end-to-end

**Fix**: Add a core validator unit test that parses
`(effect-policy id ID (target-scope "**::*") (allow-only ()))` and asserts
`policy.allowOnly === []`.

### F-B-03 P2-6: terminal-state method-call as direct unit test

**Fix**: Add a focused unit test that constructs an `Order<"Shipped">`
receiver inference + call to any method, asserting violation directly.

### F-B-04 Self-protection invariants have no isolated unit tests

**Fix**: Port the three Python checker functions to TS so they run inside
`stele check` even when Python is absent.

### F-B-05 No cross-language conformance fixture for `type-state`

**Fix**: Add `10-phase-b-type-state-disallowed-op` mirroring `09`'s
skip-on-non-TS plumbing.

### F-B-06 `stele explain effect` strict-vs-lenient divergence untested

**Fix**: Add a test that runs both `stele explain effect` and the effect
evaluator in strict mode, asserting they report different effective sets.

### F-B-07 `addChecker` command has no tests
### F-B-08 `backend-python` `_stele_runtime.py` has zero unit tests
### F-B-09 Core `validator/structure.ts` (1700 lines) has no direct unit tests
### F-B-10 Operator registry has ~26 untested operators
### F-B-11 `loadConfig` has no direct unit tests
### F-B-12 `SteleError`, `baseline/io.ts`, `errors.ts` have zero direct tests

## Bucket C — documentation drift (nice to fix)

### F-C-01 `FINAL-SPEC.md` not updated to reflect FIX_HINT rename + severity bump

**Source**: `docs/design/phase-b/FINAL-SPEC.md:141` still calls it
`FIX_HINT_NOT_VAGUE` at severity `warning`. The shipped invariant is
`FIX_HINT_REQUIRES_ANALYSIS_BRANCH` at `error`. P1-8 updated
`docs/spec/cdl.md` but **not** FINAL-SPEC.
**Fix**: Edit `FINAL-SPEC.md:141`.

### F-C-02 Spec promises `stele design propose --trace-policy <id>` flag shape that doesn't exist

**Fix**: Remove the paragraph after F-A-07 is fixed.

### F-C-03 `@deprecated` "will be removed in v0.4" tags without scheduled removal

**Source**: `packages/cli/src/architecture-runtime.ts:93,257,262`,
`packages/cli/src/design-profile/types.ts:156`
**Fix**: Schedule removal or drop the version commitment.

### F-C-04 `architecture-runtime.ts` v1 limitation referenced but no literal TODO marker

**Fix**: Audit the file and either add the TODO or fix the doc.

### F-C-05 `version.ts` hardcoded version

**Source**: `packages/cli/src/version.ts:11` — `STELE_VERSION = "0.1.0"`
**Fix**: Derive from package.json at build time.

### F-C-06 `unified-checker.ts` is a no-op stub after Phase B B.1 shipped

**Source**: `packages/type-driven-evaluator/src/unified-checker.ts:29-40`
**Fix**: Either migrate `check-stages-type-driven.ts` to dispatch through
it or delete the file.

### F-C-07 `(allow-only ())` empty-parens form documented but not literal-form-tested

(Linked to F-B-02.)

### F-C-08 `state-machine.ts` advisory `unreachableStates` not surfaced

**Source**: `packages/type-state-evaluator/src/state-machine.ts:122-135`
**Fix**: Emit a `warning`-severity notice when
`unreachableStates(decl).length > 0`.

### F-C-09 `(annotates …)` cross-reference deferred to evaluator stage

**Source**: `docs/spec/cdl.md:889`
**Fix**: Audit whether evaluator actually cross-references.

## Bucket D — test environment fragility

### F-D-01 `@stele/backend-python` translator — 10 failures (pytest not on PATH)
### F-D-02 `@stele/cli` tests — 4 failures (3 pytest + 1 Windows path on Linux)
### F-D-03 `@stele/mcp-server` — 2 failures (UNC path tests on Linux)
### F-D-04 `tests/conformance` — 7 failures (pytest absent)
### F-D-05 Fixture-runner skip-on-missing-dist now hard-fail — verify no silent-skip remains
### F-D-06 `STELE_CONFORMANCE_ALLOW_SKIP` environment behavior undocumented

## Cross-reference: Round 3 P2 status

| P2 | Source | Title | Status |
|---|---|---|---|
| P2-1 | G | `.stele/stop-state.json` symlink rejection | **OPEN** |
| P2-2 | G | HMAC sign stop-state file | **OPEN** |
| P2-3 | G | E2E test for STRICT_MODE_DEFAULT_IN_CI trigger | **OPEN** |
| P2-4 | H | Self-recursion / multi-edges-to-self unit tests | **OPEN** |
| P2-5 | H | `(allow-only ())` literal end-to-end test | **OPEN** |
| P2-6 | H | terminal-state method-call unit test | **OPEN** |

## Summary

| Bucket | Count | Examples |
|---|---|---|
| A — security / correctness | 10 | F-A-02 fail-open non-TS, F-A-07 propose-type gap, F-A-09 no dogfood |
| B — coverage gaps | 12 | F-B-01 self-recursion, F-B-08 runtime tests, F-B-10 operators |
| C — documentation drift | 9 | F-C-01 FINAL-SPEC rename, F-C-03 v0.4 tags, F-C-06 unified-checker stub |
| D — test environment fragility | 6 | F-D-01 ~10 failures, F-D-02 ~4 failures, F-D-04 ~7 failures |
| **Total** | **37** | All Round 3 P0/P1 CLOSED; all 6 Round 3 P2 OPEN |

**Key clusters** for the maintainer:

1. **Non-TS fail-open** (F-A-02) — most impactful surviving correctness gap.
2. **Propose-flow closure** (F-A-07) — required for the fix-hint A/B branch to be actionable for the three new CDL forms.
3. **Dogfood** (F-A-09) — biggest gap per the maintainer's own status doc.
4. **Test environment fragility** (Bucket D, ~23 failing tests) — masks regressions; every CI run lights up red for wrong reasons.
