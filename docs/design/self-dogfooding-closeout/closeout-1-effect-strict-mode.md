# Closeout 1 — Per-policy unresolved-call scoping (full mechanism upgrade)

**Goal:** Implement per-policy `target-scope`-bounded unresolved-call
enforcement in `@stele/effect-evaluator` so that fail-closed (Round 2
D-CG-5) semantics hold **for every node inside an active policy's
scope** without flagging unresolved calls in unrelated code.

Then delete the `effectStrictMode` field everywhere. No replacement
knob. No global downgrade. No `severity: warning` fallback.

**Why:** The current evaluator emits one
`effect.unresolved_call_blocks_evaluation` violation per unresolved
call site, regardless of whether any policy actually cares about
that node. Phase 4 shipped `effectStrictMode: false` to silence the
resulting ~1,454 noise violations — disabling fail-closed for the
entire codebase. The principled fix is to gate the emission on
policy scope membership: out-of-scope nodes simply do not emit
because no policy cares.

After this closeout: a single unresolved call inside
`packages/core/src/**` (covered by CORE_IS_PURE_OR_FS_READ) is a
HARD ERROR. The 1,454 noise hits in
`tests/conformance/runner-impl.ts` (covered by no policy) emit
nothing. The 4 existing policies all stay bound. No new failures.

**Out of scope:**
- Adding new effect-policies
- Touching effect annotations or suppressions
- Adding a new config field (CC-4 — no replacement knobs allowed)
- Changing the violation shape / fingerprint format

## Required architectural change

**File:** `packages/effect-evaluator/src/` — locate the unresolved-call
emission path (likely `evaluator.ts` or `violation-builder.ts`).

Today, paraphrased:
```ts
for each callerNode in callGraph:
  for each callee in callerNode.calls:
    if callee.kind === 'unresolved':
      emit unresolved_call_blocks_evaluation(
        rule_id: 'effect.unresolved_call_blocks_evaluation',
        severity: strictMode ? 'error' : 'warning',
        ...
      )
```

After:
```ts
// Computed ONCE at the top of evaluateEffectPolicies.
const activeScopeMatchers = policies.flatMap(p => p.compiledTargetScopes)

for each callerNode in callGraph:
  if (!matchAny(callerNode.id, activeScopeMatchers)) {
    continue  // no policy cares about this node, do not emit
  }
  for each callee in callerNode.calls:
    if callee.kind === 'unresolved':
      emit unresolved_call_blocks_evaluation(
        rule_id: 'effect.unresolved_call_blocks_evaluation',
        severity: 'error',           // always error — fail-closed restored
        ...
      )
```

Properties to preserve:

- Existing per-call-site dedup (`callGraphNodeIds.has(target)`,
  fingerprint stability).
- Existing fix-hint with the `[A] Code issue / [B] Contract issue`
  decision tree.
- Annotation extraction logic untouched.

Properties NOT to add:

- No `strictMode` parameter
- No `effectStrictMode` config
- No per-policy `severity` override
- No `--no-fail-closed` CLI flag

## Steps

### Step 1.1 — Inventory + read

Run `codegraph_search` for `unresolved_call_blocks_evaluation` and
`strictMode` across `packages/effect-evaluator/`. Read the emission
site, the test fixtures (`packages/effect-evaluator/tests/`), and
the consumer in `packages/cli/src/commands/check-stages-effect.ts`.

Document what scope-matching helper the evaluator already exposes
(it must, because `target-scope` already controls policy binding).
Reuse it; do not invent a parallel matcher.

### Step 1.2 — Extend `EvaluateEffectOptions` / internal state

Add an internal `activeScopeMatchers` array computed from the
already-compiled `targetScopePatterns` of each policy. **This is
internal state, not a new public option.** The function signature
stays binary-compatible.

If the evaluator currently re-computes scope patterns per-policy in
a hot loop, factor the compilation into a once-per-evaluator-run
step; the new gating reuses the same compiled patterns.

### Step 1.3 — Implement the gate

Insert the `if (!matchAny(callerNode.id, activeScopeMatchers))
continue` BEFORE the per-callee loop. Severity is unconditionally
`error`.

If the evaluator currently checks `strictMode` for severity
selection, remove that branch.

### Step 1.4 — Unit tests in `packages/effect-evaluator/tests/`

Add (at minimum) **three** new unit tests:

1. **In-scope unresolved call still emits error.** Feed a call graph
   with one unresolved call inside a policy's target-scope; assert
   exactly one violation with `rule_id: effect.unresolved_call_blocks_evaluation`,
   `severity: error`.
2. **Out-of-scope unresolved call emits zero.** Same graph but the
   unresolved call sits in a node OUTSIDE every policy's
   target-scope; assert zero violations.
3. **Multiple policies, overlapping scopes.** Two policies whose
   scopes overlap; an unresolved call in the overlap region emits
   exactly one violation (not one per policy).

Also add a regression test:

4. **No `strictMode` plumbing.** Assert that `EvaluateEffectOptions`
   does not contain a `strictMode` field at runtime (TS structural
   check or a simple `expect(options).not.toHaveProperty('strictMode')`).

### Step 1.5 — Delete `effectStrictMode` everywhere

Strictly serial after 1.4 is green. In one commit:

1. Remove `effectStrictMode?: boolean` from
   `packages/cli/src/config/defaults.ts::SteleConfig` and any
   exported type union.
2. Remove the parse branch in
   `packages/cli/src/config/loadConfig.ts`.
3. Remove the `deps.strictMode ?? context.config.effectStrictMode ?? true`
   plumbing in `packages/cli/src/commands/check-stages-effect.ts`.
   `deps.strictMode` itself goes too — there is no strict-mode
   concept anymore.
4. Remove `"effectStrictMode": false` from
   `/home/bot/project/stele/stele.config.json`.
5. Remove the `strictMode` field from `EvaluateEffectOptions` and
   any test fixture / sample input that passes it.
6. Search for references and clean them all up:
   ```
   rg "effectStrictMode|strictMode" packages/ stele.config.json contract/ docs/internal/ tests/
   ```
   must return zero hits AFTER the cleanup, with the SOLE exceptions
   of:
   - `docs/design/self-dogfooding/README.md` (historical decision-log entry)
   - This closeout doc itself
7. Append `\n**RESOLVED in commit <closeout-1 final SHA>.**\n` to the
   two decision-log entries in
   `docs/design/self-dogfooding/README.md` that document
   `effectStrictMode` (the Phase 4 sub-agent entry and the
   "effectStrictMode: false is a policy degradation" entry).
8. Re-lock manifest.

### Step 1.6 — Integration test: `stele check` end-to-end

`stele check` on the live repo must:

- Exit 0
- Report all 4 effect-policies as active
- Report ZERO `effect.unresolved_call_blocks_evaluation` errors
  (because no in-scope unresolved calls exist on a clean tree; the
  conformance-runner noise is out-of-scope)
- Report the same 3 `effect.suppression_active` notices as before
  (writeAtomic, writeManifest, writeHashManifest)

Capture this as a golden snapshot OR a CLI-level test in
`packages/cli/tests/` if no equivalent fixture exists.

### Step 1.7 — Multiple paired negative tests

Per CC-13: at least 2 negative tests per affected contract. The 4
effect-policies (CORE_IS_PURE_OR_FS_READ, HOOK_NO_NETWORK,
GENERATOR_NO_NETWORK_OR_CHILD_PROCESS, MANIFEST_LEAVES_ARE_PINNED)
each currently have 1 paired test. Add a SECOND for each:

- CORE_IS_PURE_OR_FS_READ: existing test uses `@stele:effects random`.
  Add a second: an unresolved dynamic call inside `packages/core/src/**`
  via `await import(...)`. Asserts
  `effect.unresolved_call_blocks_evaluation` fires (this is the new
  behaviour CC-1 closeout-1 enables).
- HOOK_NO_NETWORK: (skipped today — closeout 2 fixes this; do NOT
  un-skip in closeout 1; closeout 2 lands both negative tests
  per its CC-13 obligation — see closeout-2 step 2.4).
- GENERATOR_NO_NETWORK_OR_CHILD_PROCESS: existing test is skip;
  closeout 6's "+1 widening" section lands the scope widening AND
  both paired negative tests (see closeout-6 § "Plus 1 widening").
- MANIFEST_LEAVES_ARE_PINNED: existing test adds a synthetic
  network-effect function. Add a second: introduce a `Date.now()`
  call site OUTSIDE the 3 atomic-writer leaves and assert
  `effect.MANIFEST_LEAVES_ARE_PINNED.disallowed_effect` fires.

Note: HOOK_NO_NETWORK and GENERATOR_NO_NETWORK_OR_CHILD_PROCESS's
"second" tests are tracked in closeouts 2 and 6 respectively — they
cannot be written until the underlying mechanism gap is closed.
Closeout 1's commit message must list these as cross-referenced
deferrals (not silent omissions).

### Step 1.8 — Re-run CC-3

```
pnpm build
pnpm typecheck
node packages/cli/dist/index.js lock
node packages/cli/dist/index.js check          # exit 0
.venv/bin/pytest tests/contract -q             # 48 passed
.venv/bin/pytest contract/checker_impls/test_negative.py -q
.venv/bin/pytest packages/effect-evaluator/tests/ -q   # new tests pass
```

If `stele check` is non-zero, **do not re-add `strictMode`**. The
violations are real. Investigate the call sites.

## Acceptance criteria

- [ ] `grep -rn "effectStrictMode\|strictMode" packages/ stele.config.json contract/`
      returns zero hits (the historical decision-log doc is the only
      exception, and only on `docs/design/self-dogfooding/README.md`)
- [ ] `unresolved_call_blocks_evaluation` errors only fire for
      callers inside an active policy's `target-scope`
- [ ] All 4 effect-policies remain bound and green
- [ ] `stele check` exit 0, zero unresolved-call errors on a clean tree
- [ ] 4 new unit tests in `packages/effect-evaluator/tests/`
- [ ] 2 new paired negative tests (one per active policy where the
      mechanism allows; the other 2 are tracked in closeouts 2 and 6)
- [ ] Predecessor decision-log entries appended with RESOLVED line
- [ ] CC-3 green

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding-closeout/README.md (especially the
10-item forbidden anti-pattern list) and
docs/design/self-dogfooding-closeout/closeout-1-effect-strict-mode.md.

Execute steps 1.1 → 1.8 in order. Land in 3-4 commits (e.g.
1: evaluator change + 4 new unit tests,
2: integration test + golden snapshot,
3: config-field deletion + plumbing cleanup + decision-log + re-lock,
4: 2 new paired negative tests if not folded into earlier commits).

Forbidden moves (matches the README list):
- Introducing any new opt-out flag, env var, or config knob
- Bumping severity from error to warning anywhere
- Marking the unresolved-call check as opt-in
- Marking any test @pytest.mark.skip
- Editing source under packages/core/, packages/cli/, etc. to make
  a CDL contract pass

If the per-policy gating change causes any of the 4 effect-policies
to fire on real code, STOP. Surface the violation. The contracts are
correct; either the source is wrong (CC-12 path B: legitimate code
issue) or the evaluator implementation has a bug.

CC-12: never edit source to make a CDL contract pass.
CC-13: at least 2 negative tests per changed contract where the
       mechanism allows; cross-reference the deferrals when not.
CC-14: append RESOLVED line to decision-log entries.

DO NOT push. The main agent reviews + pushes.
```
