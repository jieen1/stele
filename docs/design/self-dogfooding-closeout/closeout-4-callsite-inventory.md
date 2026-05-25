# Closeout 4 — Call-site inventory

Inventory of every production caller that must route through the typed
lifecycle methods. Generated from grep + manual inspection of the
worktree on 2026-05-25 before refactoring.

## MANIFEST_LIFECYCLE

Target: `packages/core/src/manifest/lifecycle.ts::Manifest`
Lifecycle chain: `(value) → asLoaded → lockManifest → verifyLockedManifest`
Phase 5 typed methods exported from `@stele/core`:
`asLoaded`, `lockManifest`, `verifyLockedManifest`.

The contract MANIFEST_LIFECYCLE is distinct from the **design-generator**
manifest (`packages/cli/src/design-generator/manifest.ts`). Only the
core contract manifest is in scope — the design-generator manifest is
governed separately by APPROVAL_LIFECYCLE for the approve flow and the
generation manifest is internal to the design-generator subsystem.

Free-function production callers that need re-routing:

| # | File | Symbol used | Notes |
|---|---|---|---|
| 1 | `packages/cli/src/commands/lock.ts:54` | `writeManifest(paths, manifestPath, contractHash)` | Final `stele lock` step. Chain: build paths/hash → wrap typed → write. |
| 2 | `packages/cli/src/commands/baseline.ts:160` | `writeManifest(...)` | Intermediate locked-state write in `baselineProject`. |
| 3 | `packages/cli/src/commands/baseline.ts:180` | `writeManifest(...)` | Final state write in `baselineProject`. |
| 4 | `packages/cli/src/commands/check-stages-protected.ts:132` | `verifyManifest(manifestPath)` | Reads on-disk manifest and verifies; result is then projected to a `Verified` brand. |

Strategy: introduce two typed wrappers in
`packages/core/src/manifest/lifecycle.ts`:

- `writeLockedManifest(locked: Manifest<"Locked">, paths, hash, manifestPath)` —
  the only sanctioned write entry; the underlying free-function
  `writeManifest` becomes its sole implementation site (no second
  wrapper, no back-compat shim, per CC-4).
- `verifyManifestToVerified(manifestPath): Promise<{ manifest: Manifest<"Verified">, verification: VerificationResult }>` —
  the only sanctioned read+verify entry that returns a
  `Manifest<"Verified">`. Internally delegates to `verifyManifest`.

The four call sites above import only the typed wrappers; the
underlying `writeManifest` / `verifyManifest` free-function exports stay
because they remain the canonical I/O implementation, but every
production caller chains through the typed wrappers (binding declarations
target the typed wrappers, not the free functions).

## APPROVAL_LIFECYCLE

Target: `packages/cli/src/commands/design/approval-lifecycle.ts::Approval`
Lifecycle chain: `draftApproval → attachApprovedBy → signApproval`
Phase 5 typed methods: `draftApproval`, `attachApprovedBy`, `signApproval`.

Free-function production callers:

| # | File | Symbol used | Notes |
|---|---|---|---|
| 5 | `packages/cli/src/commands/design/approve.ts:259` | `writeFileSync(approvalPath, JSON.stringify(approval, null, 2))` | The single production approval write. Currently constructs a plain object; needs `draftApproval → attachApprovedBy → signApproval → writeSignedApproval`. |

Strategy: introduce `writeSignedApproval(approval: Approval<"Signed">, approvalPath)` in
`packages/cli/src/commands/design/approval-lifecycle.ts`. `runDesignApprove`
chains the three transitions before calling it.

## DESIGN_PROFILE_LIFECYCLE

Target: `packages/cli/src/design-profile/lifecycle.ts::TypedDesignProfile`
Lifecycle chain: `asRawProfile → markProfileValidated → hashValidatedProfile`
Phase 5 typed methods: `asRawProfile`, `markProfileValidated`, `hashValidatedProfile`.

The lifecycle gate is `useHashedProfile` — every production consumer of
a profile must accept a `HashedDesignProfile`, never a raw / Validated /
`DesignProfile` shape.

Free-function production callers:

| # | File | Symbol used | Notes |
|---|---|---|---|
| 6 | `packages/cli/src/commands/check-stages-type-state.ts:287` | `loadProfile(context.projectDir)` | Reads tsconfig override only. |
| 7 | `packages/cli/src/commands/check-stages-type-driven.ts:51` | `loadProfile(context.projectDir)` | Full profile used downstream. |
| 8 | `packages/cli/src/commands/check.ts:458` | `loadProfile(projectDir)` | Driver. |
| 9 | `packages/cli/src/commands/check-stages-effect.ts:300` | `loadProfile(context.projectDir)` | Reads tsconfig override only. |
| 10 | `packages/cli/src/commands/check-stages-trace.ts:249` | `loadProfile(context.projectDir)` | Reads tsconfig override only. |
| 11 | `packages/cli/src/commands/maintenance.ts:76` | `loadProfile(projectDir)` | Hash + project info. |
| 12 | `packages/cli/src/commands/rules.ts:191` | `loadProfile(projectDir)` | Optional profile read. |
| 13 | `packages/cli/src/commands/design/explain.ts:58` | `await loadProfile(projectDir)` | Reads downstream fields. |
| 14 | `packages/cli/src/commands/design/diff.ts:979` | `loadProfile(projectDir)` | Reads downstream fields. |
| 15 | `packages/cli/src/commands/design/propose.ts:31` | `await loadProfile(projectDir)` | Reads downstream fields. |
| 16 | `packages/cli/src/commands/design/propose.ts:161` | `await loadProfile(projectDir)` | Second read. |
| 17 | `packages/cli/src/commands/design/check.ts:54` | `await loadProfile(projectDir)` | + `validateProfile(profile)` immediately after. |
| 18 | `packages/cli/src/commands/design/approve.ts:187` | `loadProfile(projectDir)` | Reads downstream fields. |
| 19 | `packages/cli/src/commands/design/generate.ts:31` | `await loadProfile(projectDir)` | + `validateProfile(profile)` immediately after; feeds generator. |
| 20 | `packages/cli/src/commands/check-stages-toolchain.ts:30` | `loadProfile(context.projectDir)` | Reads downstream fields. |

Strategy: replace the free-function `loadProfile(projectDir)` exported
from `packages/cli/src/design-profile/load.ts` with a typed pipeline that
returns a `HashedDesignProfile`. The free function becomes the internal
loader; the public export becomes
`loadHashedProfile(projectDir, profilePath?): Promise<HashedDesignProfile>`
which chains `asRawProfile → markProfileValidated → hashValidatedProfile`.
Every call site above now consumes `HashedDesignProfile` (which exposes
`{ profile, contentHash }`); downstream readers reach into `.profile`.

## CALLGRAPH_LIFECYCLE

Target: `packages/call-graph-core/src/lifecycle.ts::TypedCallGraph`
Lifecycle chain: `emptyCallGraph → startBuilding → finalizeCallGraph → cacheCallGraph`
Phase 5 typed methods: `emptyCallGraph`, `startBuilding`, `finalizeCallGraph`, `cacheCallGraph`.

The lifecycle's terminal/consumable state is `Built` or `Cached`.
Every evaluator must accept only `TypedCallGraph<"Cached">` (preferred)
or `TypedCallGraph<"Built">` (when cache is skipped).

Free-function / extractor production callers:

| # | File | Symbol used | Notes |
|---|---|---|---|
| 21 | `packages/cli/src/commands/check-stages-trace.ts:282` (`extractOrCacheCallGraph`) | `extractor.extract({ ... })` then `setCachedCallGraph` | Builds + caches. |
| 22 | `packages/cli/src/commands/check-stages-type-state.ts:312` (`extractOrCacheCallGraph`) | `extract({ ... })` then `setCachedCallGraph` | Builds + caches. |
| 23 | `packages/cli/src/commands/check-stages-effect.ts:330` (`extractOrCacheCallGraph`) | `extract({ ... })` then `setCachedCallGraph` | Builds + caches. |
| 24 | `packages/cli/src/commands/check-stages-call-graph-cache.ts:13–25` (`getCachedCallGraph` / `setCachedCallGraph`) | Untyped `CallGraph` | Cache plumbing. |

Strategy: refactor the shared cache module to hold and return
`TypedCallGraph<"Cached">`. Each `extractOrCacheCallGraph` chains
`emptyCallGraph → startBuilding → finalizeCallGraph → cacheCallGraph`
before handing the result to the evaluator. The cache stores the
already-typed value, so consumers see `TypedCallGraph<"Cached">` from
both fresh extraction and re-use paths.

## Summary

24 call sites total across the four lifecycles:

- MANIFEST: 4 sites
- APPROVAL: 1 site
- DESIGN_PROFILE: 15 sites
- CALLGRAPH: 4 sites (3 extractor sites + 1 cache module)

This matches the doc's 19–29 estimate.

## Evaluator extension (pre-flight finding)

`packages/type-state-evaluator/src/evaluator.ts` currently treats a
`(type-state-binding ...)` declaration purely as a SUPPRESSOR for
inference-failed cases (function `anyBindingCovers` at line 289). It
does NOT emit any runtime violation when a binding's declared
`(param N state X)` disagrees with the static inferred state at the
caller — only `disallowed_op` and `inference_failed` rule_ids are
emitted.

To honour the doc's step 4.7 requirement (Test B: runtime evaluator
proof), the evaluator MUST be extended to emit
`typestate.<LIFECYCLE>.wrong_state_at_binding` whenever:

- a `type-state-binding` declaration covers a caller, AND
- a backend inference exists for that caller's param, AND
- the inferred state is definite (not undefined), AND
- the inferred state does not match the binding's declared state.

This is the closeout's evaluator extension scope.
