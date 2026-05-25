# Closeout 6 — Land the 5 deferred contracts (Phase 2 × 3 + Phase 3 × 2)

**Goal:** Land every contract that the original plan deferred:

- **Phase 2 deferrals (3):** `MANIFEST_ENGINE_SHAPE`,
  `VIOLATION_REPORT_SHAPE`, `RULE_ID_FIELDS_BRANDED`
- **Phase 3 deferrals (2):** `EVALUATOR_VIA_EXTERN_REGISTRY`,
  `BACKEND_LOAD_VIA_REGISTRY`

Each lands with at least 2 paired negative tests (CC-13). No skips.

**Why:** Round 16 + the Q2 summary doc confirmed these 5 are still
outstanding. The original deferrals had legitimate reasons (Phase 3's
were extractor limitations; Phase 2's were resolution issues). With
closeouts 2 and 3a in place, those underlying limitations are gone.

**Out of scope:**
- New contracts beyond these 5
- Re-litigating the original deferral rationales

## Pre-flight

Closeouts 1, 2, 3a, 3b, 4, 5 must all be landed and CC-3 green
before this closeout starts. In particular:

- Closeout 2 (allowJs) brings hook scripts and any other `.js`
  callers into the graph — relevant for `EVALUATOR_VIA_EXTERN_REGISTRY`
  if it touches dynamic-import sites.
- Closeout 3a (free-function class-shape) enables
  `MANIFEST_ENGINE_SHAPE` and `VIOLATION_REPORT_SHAPE` to bind
  without needing a class wrapper.

## Plus 1 widening (GENERATOR_NO_NETWORK_OR_CHILD_PROCESS)

The Phase 4 effect-policy `GENERATOR_NO_NETWORK_OR_CHILD_PROCESS`
currently targets a single file (`packages/cli/src/commands/generate.ts::*`),
making it impossible to write a sibling-drop negative test. Its
existing test is `@pytest.mark.skip`-ed. Closeout 6 widens the
target-scope so the policy covers the full generation pipeline
(`packages/cli/src/commands/generate.ts` plus
`packages/cli/src/design-generator/**::*`) and the test becomes
real.

- Widen scope via propose/approve in `contract/main.stele`.
- Un-skip `test_generator_no_network_or_child_process_catches_execfile`;
  rewrite the body to drop a synthetic sibling under
  `packages/cli/src/design-generator/` that imports `node:child_process`
  and calls `execFile(...)`. Assert
  `effect.GENERATOR_NO_NETWORK_OR_CHILD_PROCESS.forbidden_effect` fires.
- Per CC-13, add a second paired negative test:
  `test_generator_no_network_or_child_process_catches_fetch`. Drop
  a sibling that calls `fetch(...)` instead. Different effect kind →
  asserts the policy covers both `network` and `child-process`.

This is **closeout 6's 6th deliverable** (not part of the 5
deferred contracts, but co-located here because the underlying
mechanism — widening target-scope to a directory — is the same
shape of work as the boundary-style contracts in 6.5).

Append the predecessor decision-log entries that mention
`GENERATOR_NO_NETWORK_OR_CHILD_PROCESS` with the RESOLVED line at
the end of closeout 6.

## The 5 contracts

### 6.1 — `MANIFEST_ENGINE_SHAPE` (class-shape via free-function target)

**Target:** the manifest engine free-function APIs in
`packages/core/src/manifest/`. Concretely the surface formed by
`writeManifest`, `verifyManifest`, `loadManifest`, plus the typed
lifecycle methods Closeout 4 introduces.

**Constraints:**
- Required methods (sibling exports): `writeManifest`, `verifyManifest`,
  `loadManifest`, `asLoaded`, `lockManifest`, `verifyLockedManifest`
- Required fields: none (functional API).

**Paired negative tests:**
- Remove `verifyManifest` export → contract fires.
- Rename `writeManifest` to `_writeManifest` → contract fires.

### 6.2 — `VIOLATION_REPORT_SHAPE` (class-shape on report builder)

**Target:** `packages/core/src/report/` shape builder.

**Constraints:**
- Required methods: `buildReport`, `addViolation`, `addNotice`,
  `finalize`
- Required fields: depending on actual shape — `violations`,
  `notices`, `summary`

**Paired negative tests:**
- Remove `finalize` method/export → fires.
- Remove `notices` field → fires.

### 6.3 — `RULE_ID_FIELDS_BRANDED` (type-policy on the report types)

**Target:** every interface/type in `@stele/core` whose name ends in
`...Violation` or `...Notice` or `...Report` whose `rule_id` field
must be typed as `RuleId` (not `string`).

**Mechanism:** `type-policy` declaration:

```scheme
(type-policy RULE_ID_FIELDS_BRANDED
  (lang typescript)
  (target "packages/core/src/**/*.ts::*::rule_id")
  (must-be "RuleId"))
```

Substitute the correct selector syntax — investigate the existing
`no-any-in-core` type-policy for the form.

**Paired negative tests:**
- Mutate one `rule_id: RuleId` declaration to `rule_id: string`
  → fires.
- Mutate another to `rule_id: any` → fires (overlaps with
  no-any-in-core; the test asserts BOTH contracts fire on the same
  source).

### 6.4 — `EVALUATOR_VIA_EXTERN_REGISTRY` (trace-policy)

**Target:** `packages/cli/src/commands/check-stages-trace.ts::buildTraceStage`
must call `buildExternAliasRegistry` before invoking
`evaluateTracePolicies`.

**Problem from Phase 3 deferral:** the TS extractor did not track
calls through local-variable holders of imported functions.

**Resolution paths (sub-agent picks the right one):**
- (A) Closeout 2's `allowJs` change ALSO improved
  local-variable-holder resolution → just declare the contract.
  Verify with the existing call graph.
- (B) Refactor `check-stages-trace.ts` to call
  `evaluateTracePolicies` directly (no DI seam through a local
  variable). Sacrifices testability — but the test seam may have
  alternatives (a separate facade module).
- (C) Extend the extractor (`resolve-callee.ts`) to track
  local-variable bindings of imported functions. Larger but most
  principled — would also unblock future contracts.

Pick (C) if the inventory shows multiple similar bindings; else (B)
or (A).

**Paired negative tests:**
- Mutate `buildTraceStage` to skip `buildExternAliasRegistry` →
  contract fires.
- Mutate the registry build to a no-op stub returning `{}` →
  contract fires (the registry must actually be the live one).

### 6.5 — `BACKEND_LOAD_VIA_REGISTRY` (boundary, not trace-policy)

**Phase 3 deferral notes** correctly identified this as an
IMPORT-level boundary, not a call-graph trace. Re-land as a
`(boundary …)` code-shape contract:

```scheme
(boundary BACKEND_LOAD_VIA_REGISTRY
  (lang typescript)
  (scope "packages/cli/src/**/*.ts")
  (deny-import "@stele/backend-python")
  (deny-import "@stele/backend-typescript")
  (deny-import "@stele/backend-go")
  (deny-import "@stele/backend-rust")
  (deny-import "@stele/backend-java")
  (allow-from "packages/cli/src/backend-registry.ts"))
```

Substitute the correct allow-from / except patterns — investigate
the boundary evaluator's actual syntax.

**Paired negative tests:**
- Add a fresh `import` of `@stele/backend-python` in a file outside
  `backend-registry.ts` → contract fires.
- Add a typeof-import (`import type`) → expected behaviour
  documented (does it fire? probably should NOT, since type-only
  imports erase). Either way, the test asserts the documented
  behaviour explicitly.

## Steps

### Step 6.1 — Inspect actual evaluator syntax for each mechanism

Read `docs/spec/cdl.md` and the closest existing examples for
`(type-policy …)`, `(boundary …)`, and class-shape free-function
targets. The exact field names in this doc are illustrative.

### Step 6.2 — Land contracts one at a time

Each contract: declaration in `contract/main.stele` → re-lock →
verify it binds (check the JSON report includes its rule_id) → 2
paired negative tests → CC-3 green → commit.

5 contracts × 1 commit each = 5 commits.

### Step 6.3 — Update predecessor decision-log

Append `RESOLVED in commit <SHA>` to:

- Phase 2 deferred items (3 entries)
- Phase 3 deferred items (2 entries)

### Step 6.4 — CC-3 final

```
pnpm build && pnpm typecheck
node packages/cli/dist/index.js lock
node packages/cli/dist/index.js check
.venv/bin/pytest tests/contract -q
.venv/bin/pytest contract/checker_impls/test_negative.py -q
```

10 new negative tests pass (2 per contract × 5).

## Acceptance criteria

- [ ] 5 new contracts in `contract/main.stele`, all binding
- [ ] 10 new paired negative tests for the 5 contracts
- [ ] GENERATOR_NO_NETWORK_OR_CHILD_PROCESS scope widened; 2 paired
      tests un-skipped + live (12 new negative tests total in this
      closeout)
- [ ] `stele check` exit 0
- [ ] Decision-log entries for all 5 deferrals AND
      GENERATOR_NO_NETWORK_OR_CHILD_PROCESS appended with RESOLVED
      line

## Sub-agent execution prompt

```
Read README.md (forbidden anti-pattern list) and
closeout-6-deferred-contracts.md.

Execute steps 6.1 → 6.4. Land in 5+ commits (one per contract +
the decision-log update at the end).

Forbidden:
- Marking a contract as "advisory" or "preview" to make it pass
- Adding (must-have-method ?X)-style optional wildcards to dodge
  binding misses
- Lowering severity from error to warning

If a contract fires unexpectedly on real code, the contract is
correct; either fix the source (CC-12 path A) or refine the
contract via propose/approve (CC-12 path B). Never silence.

DO NOT push.
```
