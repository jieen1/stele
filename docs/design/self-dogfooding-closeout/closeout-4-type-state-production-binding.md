# Closeout 4 — Route every production caller through typed lifecycle methods

**Goal:** Route every production call site that touches Manifest /
Approval / DesignProfile / CallGraph through the typed lifecycle
methods defined in Phase 5. The type-state evaluator must report
**>0 bound call sites for each of the 4 lifecycles**, and every
production caller is type-state safe.

**Why:** Phase 5 landed compile-time state-brand enforcement
(`@ts-expect-error` proofs in `.test-d.ts` files) but production
callers continue to use the original free-function APIs
(`writeManifest`, `verifyManifest`, `loadProfile`,
`validateProfile`, the call-graph extractor entrypoints,
`resolveApprovedBy` → write). Result: the type-state evaluator binds
zero real call sites. The lifecycles are documentation today.

After this closeout:

- Every production caller of the four lifecycles' free-function APIs
  routes through the typed `asLoaded → lockManifest → verifyLockedManifest`
  (and analogous) chains.
- `@stele/type-state-evaluator` reports binding for each of the 4
  lifecycles when `stele check` runs.
- `type-state-binding` declarations are added to `contract/main.stele`
  pinning the typed entry points.
- The 4 brand-fires `.test-d.ts` tests continue to pass (compile-time
  invariant preserved).

**Out of scope:**
- Adding new lifecycle stages
- Changing the brand discriminator design (V-05 fix stays)

## Scope inventory

Per Round 16 / Phase 5 decision log, expected refactor surface:

- **MANIFEST_LIFECYCLE** — ~3 sites: `lock.ts`, `baseline.ts`,
  `check-stages-protected.ts`
- **APPROVAL_LIFECYCLE** — ~1 site: `approve.ts`
- **DESIGN_PROFILE_LIFECYCLE** — ~10–15 sites: every generate /
  check entry that loads a profile
- **CALLGRAPH_LIFECYCLE** — ~5–10 sites: every evaluator invocation

That is 19–29 call-site refactors. Closeout 4 lands them ALL. No
"deferred to later" — that was the Phase 5 outcome and the user
explicitly rejected it.

## Required design adjustments

The Phase 5 lifecycle modules
(`packages/core/src/manifest/lifecycle.ts`,
`packages/cli/src/commands/design/approval-lifecycle.ts`,
`packages/cli/src/design-profile/lifecycle.ts`,
`packages/call-graph-core/src/lifecycle.ts`) expose the typed
methods. Their state-keyed brands should NOT change.

If a typed method does not exist for a production caller's use case
(e.g. an "asVerified" terminal stage that callers downstream want),
add it as a new lifecycle method following the same brand pattern.
Document each new method in the corresponding `lifecycle.ts`
docstring.

**Evaluator extension (if needed):** the pre-flight in step 4.7
determines whether `@stele/type-state-evaluator` already emits a
runtime violation for type-state-binding mismatches. If it does
NOT, closeout 4 ALSO extends the evaluator to emit one:

- Rule_id format: `typestate.<LIFECYCLE>.wrong_state_at_binding`
- Severity: error
- Fingerprint: stable per (lifecycle, target NodeId, expected state,
  actual state)
- Fires whenever the evaluator sees a call site bound by a
  `type-state-binding` declaration AND the static analysis of the
  argument's state disagrees with the binding's declared state.

This is part of closeout 4's deliverables; do not split into a
separate closeout. Add 3+ unit tests to
`packages/type-state-evaluator/tests/` covering the new violation
path before relying on it in the negative tests of step 4.7.

## Steps

### Step 4.1 — Inventory per lifecycle

Use `codegraph_callers` (or grep) on each free-function API:

```
writeManifest, verifyManifest, hashFile (MANIFEST)
resolveApprovedBy, writeApproval (APPROVAL — adjust to actual names)
loadProfile, validateProfile (DESIGN_PROFILE)
extractCallGraph and friends (CALLGRAPH)
```

For each lifecycle: produce a checklist of call sites that need
re-routing. The sub-agent's first commit is this checklist as a
work-in-progress file under
`docs/design/self-dogfooding-closeout/closeout-4-callsite-inventory.md`.

### Step 4.2 — Refactor MANIFEST callers

Each site is rewritten roughly as:

Before:
```ts
const data = JSON.parse(await readFile(path, "utf8"))
writeManifest(target, data)
```

After:
```ts
const draft = readManifestUnloaded(path)         // -> Unloaded
const loaded = asLoaded(draft)                    // -> Loaded
const locked = lockManifest(loaded, lockOpts)     // -> Locked
const verified = verifyLockedManifest(locked)     // -> Verified
writeVerifiedManifest(verified, target)           // typed write
```

Names are illustrative — match the actual `packages/core/src/manifest/lifecycle.ts`
API. If a method does not exist, add it (see "Required design
adjustments" above).

After each call-site refactor: typecheck the package + run that
package's tests.

### Step 4.3 — Refactor APPROVAL callers

Same pattern, against `approval-lifecycle.ts`. The single
production site (`approve.ts`) should chain
`Drafting → IdentityChecked → Signed`. The
`@ts-expect-error` proofs in `approval-lifecycle.test-d.ts` must
continue to fire.

### Step 4.4 — Refactor DESIGN_PROFILE callers

Larger surface (10–15 sites). Group commits by directory:

- `packages/cli/src/commands/check.ts` and related
- `packages/cli/src/commands/generate.ts`
- `packages/cli/src/commands/design/*.ts`
- `packages/cli/src/commands/verify.ts` (if it exists)

Each commit: refactor → typecheck → run relevant tests. The lifecycle
is `Raw → Validated → Hashed`.

### Step 4.5 — Refactor CALLGRAPH callers

Per-stage: trace, type-state, effect, type-driven, architecture
each invoke the extractor. The lifecycle is
`Empty → Building → Built → Cached`. Threading the typed value
through means each stage receives a `CallGraph<Cached>` (or
`CallGraph<Built>` if cache is bypassed) instead of an untagged
`CallGraph`.

The `check-stages-call-graph-cache.ts` file is the central
coordinator; refactor it first so downstream stages consume the
typed value.

### Step 4.6 — Type-state-binding declarations

Add to `contract/main.stele`:

```scheme
(type-state-binding
  (target "packages/core/src/manifest/manifest.ts::writeManifest")
  (param 0 in-state Locked))
(type-state-binding
  (target "packages/cli/src/commands/design/approve.ts::writeApproval")
  (param 0 in-state Signed))
(type-state-binding
  (target "packages/cli/src/design-profile/loader.ts::useProfile")
  (param 0 in-state Hashed))
(type-state-binding
  (target "packages/call-graph-core/src/extractor.ts::useGraph")
  (param 0 in-state Cached))
```

(Names illustrative — substitute real entry-point names.)

After binding declarations land, `stele check` must show the
type-state evaluator binding >0 sites per lifecycle.

### Step 4.7 — Paired negative tests (CC-13: 2 per lifecycle, different shape)

**Pre-flight:** investigate what violation the type-state evaluator
actually emits when a `type-state-binding` constraint is violated.
Run a probe: declare a fake binding, mutate the source so a
caller passes the wrong state, observe the rule_id (likely
`typestate.<LIFECYCLE>.wrong_state` or similar — DO NOT guess; read
the evaluator source under `packages/type-state-evaluator/src/`).

If the evaluator does NOT yet emit any runtime violation for
type-state-binding mismatches (only emits binding-info notices),
then closeout 4 MUST also extend the evaluator to emit a runtime
violation. This is part of the closeout scope; do not defer.

Each lifecycle gets 2 negative tests of DIFFERENT shape:

- **Test A: wrong-state compile-time mutation.** Mutate the call
  site to pass a wrong-state value (e.g. an `Unloaded` manifest into
  the `Locked`-requiring write). Assert `tsc --noEmit` reports
  TS2345 at that file:line (compile-time enforcement, no runtime
  involvement).
- **Test B: unwrap-the-typed-wrapper mutation.** Mutate source to
  drop the typed wrapper call (the caller calls the underlying
  free-function API directly, bypassing the lifecycle chain). Assert
  the type-state evaluator emits the runtime violation rule_id
  identified in pre-flight (the rule_id MUST be a real string the
  evaluator emits, captured during pre-flight; the doc does not
  guess it).

Tests A and B are structurally different: A is a tsc-level brand
proof, B is a runtime evaluator proof. They jointly verify both
enforcement layers.

The first 4 `.test-d.ts` brand-fires tests from Phase 5 stay; these
8 new tests are ADDITIONAL.

### Step 4.8 — Update predecessor decision-log

Append `RESOLVED in commit <closeout-4 final SHA>` to:

- README.md § "Phase 5 deferred items (re-scope to Phase 7)"
- Q2 summary doc § "Phase 5 deferrals (system-wide)"

### Step 4.9 — CC-3

```
pnpm build && pnpm typecheck                 # must stay green throughout
node packages/cli/dist/index.js lock
node packages/cli/dist/index.js check        # 4 lifecycles bind to real sites
.venv/bin/pytest tests/contract -q
.venv/bin/pytest contract/checker_impls/test_negative.py -q
```

If `tsc` fails at any intermediate commit: that is the lifecycle
working as designed (the brand discriminator is catching a wrong-
state call). Fix the call site, do NOT cast to `any` or
`@ts-expect-error` it away.

## Acceptance criteria

- [ ] `stele check` shows >0 bound call sites for each of the 4
      lifecycles (verifiable via the type-state evaluator's
      diagnostic output)
- [ ] All previously identified production sites route through
      typed lifecycle methods
- [ ] 4+ `type-state-binding` declarations in `contract/main.stele`
- [ ] 8 new paired negative tests (2 per lifecycle)
- [ ] No `any` casts or `@ts-ignore` introduced
- [ ] Phase 5 `.test-d.ts` brand-fires tests still pass
- [ ] Predecessor decision-log appended with RESOLVED lines

## Sub-agent execution prompt

```
Read README.md (forbidden anti-pattern list!) and
closeout-4-type-state-production-binding.md.

Execute steps 4.1 → 4.9. Land in 6-10 commits (one per lifecycle
section + the binding declarations + tests).

Forbidden:
- `any` casts, `@ts-ignore`, `@ts-expect-error` (except the existing
  Phase 5 .test-d.ts brand-fires assertions)
- "Just for now" backward-compat wrappers
- Marking a refactor commit "WIP" — every commit is CC-3 green
- Skipping a production caller because "it's only used in tests"
- Adding a new lifecycle method without a docstring + test

If `tsc` fails after a refactor commit, the brand is doing its job.
Fix the call site (route it through the correct typed method); do
NOT silence the error.

DO NOT push.
```
