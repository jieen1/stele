# Phase 5 — Type-State Lifecycles for Stele's Core Objects

**Goal:** Give 4 core objects (Manifest, Approval, DesignProfile,
CallGraph) phantom-type state machines that prevent illegal
transitions (e.g. writing a manifest in the "Unloaded" state) at
TypeScript compile-time AND validate the same machines via
`@stele/type-state-evaluator` at `stele check` time.

**Why:** Today these objects have informal lifecycles enforced by
runtime checks scattered across the codebase. Type-state is exactly
the mechanism Stele advertises for "lifecycle invariants". Not using
it on our own core data structures is the worst kind of self-betrayal.

**Estimated effort:** 4 working days.

**Out of scope:**
- Type-state on user-facing APIs of @stele/cli commands
- Refactoring the runtime state machines (only the type-level overlay)

## Required dependencies

- **Phase 0** (`phaseLanguages.typeState = "typescript"`)
- **Phase 1** (branded types — these will appear as parameters of
  the state-transition methods)

## The 4 lifecycles

### Step 5.1 — `MANIFEST_LIFECYCLE`

**States:** `Unloaded` → `Loaded` → `Locked` → `Verified`

**Transitions:**
- `readHashManifest` (or `tryReadManifest`): `Unloaded` → `Loaded`
- `writeManifest`: `Loaded` → `Locked`
- `verifyManifest`: `Locked` → `Verified`

**Type-state design (in `packages/core/src/manifest/lifecycle.ts`):**

**Reviewer V-05 fix:** the naive `unique symbol` brand keyed on a
single property does NOT make `Manifest<"Loaded">` and
`Manifest<"Locked">` incompatible — TS structural typing accepts
either where the other is required because the property NAME is
identical. The brand MUST be **discriminated by state name**:

```ts
export type ManifestState = "Unloaded" | "Loaded" | "Locked" | "Verified";

// State-keyed brand: `Manifest<"Loaded">` has `__state_Loaded: true`
// and `__state_{Unloaded,Locked,Verified}: never`. Passing
// `Manifest<"Loaded">` where `Manifest<"Locked">` is expected fails
// because `__state_Locked` would have to be `true` but is `never`.
type StateBrand<S extends ManifestState> = {
  readonly [K in ManifestState as `__state_${K}`]: K extends S ? true : never;
};

export type Manifest<S extends ManifestState = "Loaded"> = HashManifest & StateBrand<S>;

export function readManifestAsLoaded(...): Promise<Manifest<"Loaded">>;
export function lockManifest(m: Manifest<"Loaded">): Manifest<"Locked">;
export function verifyManifest(m: Manifest<"Locked">): Manifest<"Verified">;
```

**Compile-time test obligation:** Phase 5 must include a
`packages/core/tests/manifest-lifecycle.test-d.ts` (or `.test.ts`
with `@ts-expect-error`) file asserting that:

```ts
const loaded: Manifest<"Loaded"> = readManifestAsLoaded(…) as any;
// @ts-expect-error — Loaded cannot be passed where Locked is required
verifyManifest(loaded);
```

If this test file compiles without the expected error, the brand
design is broken and Phase 5 must NOT land. Run `tsc --noEmit` and
verify the expected error fires.

**CDL declaration:**

```lisp
(type-state MANIFEST_LIFECYCLE
  (description "Manifest object goes Unloaded → Loaded → Locked → Verified. Reading any field besides metadata in Unloaded is a violation; writing in Loaded but not Locked is a violation.")
  (severity error)
  (target "packages/core/src/manifest/lifecycle.ts::Manifest")
  (initial Unloaded)
  (state Unloaded
    (allow-op constructor))
  (state Loaded
    (allow-op read.protected_files)
    (allow-op read.contract_hash)
    (transition lockManifest -> Locked))
  (state Locked
    (allow-op write.disk)
    (transition verifyManifest -> Verified))
  (state Verified
    (allow-op read.all))
  (fix-hint "[A] You called a method on a Manifest in the wrong state; route through readManifestAsLoaded → lockManifest → verifyManifest. [B] If the lifecycle is wrong, update the type-state declaration."))

(type-state-binding
  (target "packages/core/src/manifest/manifest.ts::writeManifest")
  (param 0 in-state Locked)
  (param-binding manifestArg))
```

### Step 5.2 — `APPROVAL_LIFECYCLE`

**States:** `Drafting` → `IdentityChecked` → `Signed`

**Transitions:**
- `createDraftApproval`: → `Drafting`
- `resolveApprovedBy`: `Drafting` → `IdentityChecked`
- `writeApprovalRecord`: `IdentityChecked` → `Signed`

```lisp
(type-state APPROVAL_LIFECYCLE
  (description "Approval record cannot be written to disk before the human-identity gate has run. Drafting → IdentityChecked → Signed.")
  (severity error)
  (target "packages/cli/src/commands/design/approve.ts::Approval")
  (initial Drafting)
  (state Drafting
    (transition resolveApprovedBy -> IdentityChecked))
  (state IdentityChecked
    (transition writeApprovalRecord -> Signed))
  (state Signed
    (allow-op read.all)))
```

### Step 5.3 — `DESIGN_PROFILE_LIFECYCLE`

**States:** `Raw` → `Validated` → `Hashed`

**Transitions:**
- `loadProfile`: → `Raw`
- `validateProfile`: `Raw` → `Validated`
- `hashFile` (returns the hashed wrapper): `Validated` → `Hashed`

```lisp
(type-state DESIGN_PROFILE_LIFECYCLE
  (description "DesignProfile must be validated before its hash is computed. Generators may only consume Hashed profiles.")
  (severity error)
  (target "packages/cli/src/design-profile/types.ts::DesignProfile")
  (initial Raw)
  (state Raw
    (transition validateProfile -> Validated))
  (state Validated
    (transition hashProfile -> Hashed))
  (state Hashed
    (allow-op generate)))
```

### Step 5.4 — `CALLGRAPH_LIFECYCLE`

**States:** `Empty` → `Building` → `Built` → `Cached`

```lisp
(type-state CALLGRAPH_LIFECYCLE
  (description "Phase B evaluators may only consume a Built or Cached CallGraph. Calling an evaluator on a graph that's still Building is undefined behaviour.")
  (severity error)
  (target "packages/call-graph-core/src/types.ts::CallGraph")
  (initial Empty)
  (state Empty
    (transition startExtract -> Building))
  (state Building
    (transition finalize -> Built))
  (state Built
    (allow-op evaluate)
    (transition cache -> Cached))
  (state Cached
    (allow-op evaluate)))
```

## Implementation steps

### Step 5.5 — Land the type-state types FIRST (no CDL yet)

Add the phantom-type wrappers + state-transition functions to TS
source. Don't add CDL contracts yet — first verify the runtime works
under tsc.

This step refactors:
- `packages/core/src/manifest/manifest.ts` — split into `lifecycle.ts`
  with the typed surface
- `packages/cli/src/commands/design/approve.ts` — extract the
  approval record building into a typed pipeline
- `packages/cli/src/design-profile/load.ts` — return `DesignProfile<"Raw">`
- `packages/call-graph-core/src/types.ts` — add the `CallGraph<S>` brand

Each adds ~5–20 lines of phantom-type plumbing.

### Step 5.6 — Add the 4 `type-state` declarations

Now add the CDL declarations from 5.1–5.4. Run `stele check`. The
evaluator + ts-type-state-inference-extractor will verify each
call-site uses the right state.

### Step 5.7 — Add 4 negative tests

Each test mutates a call site to use a Wrong-state argument (e.g.
pass `Manifest<"Loaded">` where `Manifest<"Locked">` is required)
and asserts the policy fires.

### Step 5.8 — Re-lock + verify

```
pnpm build
node packages/cli/dist/index.js generate --force
node packages/cli/dist/index.js lock --reason "Phase 5: 4 type-state lifecycles"
node packages/cli/dist/index.js check     # ~74 invariants
```

## Acceptance criteria

- [ ] 4 type-state declarations
- [ ] 4 type-state-binding declarations (one per state-changing entry point)
- [ ] All 4 enforced at TS compile time (phantom types)
- [ ] All 4 enforced at `stele check` time (evaluator)
- [ ] 4 negative tests
- [ ] No regression in any other suite

## Dependencies

- Phase 0, Phase 1 (branded types make state-transition signatures clean)

## Rollback strategy

Per-lifecycle revert. Each is in its own commit.

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding/README.md and
docs/design/self-dogfooding/phase-5-type-state.md.

Confirm Phase 0 + 1 are complete.

Phase 5 is the highest-risk phase — it refactors core types. Land
one lifecycle at a time (5.1 first, fully green, before 5.2). Each
lifecycle is ~1 day of work including refactor + CDL + negative test.
```
