# Self-Protection Coverage Matrix

**Status:** generated 2026-05-25 (Phase 7 step 7.1); type-state row updated
2026-06-03; **vacuity sweep 2026-06-04** (see §2026-06-04 below).
**Owner:** self-dogfooding plan (`docs/design/self-dogfooding/`)
**Live counts:** 52 invariants · 132 negative tests · run `stele list` for the
live invariant count. (The 48 / 88 figures below were the 2026-05-25 snapshot.)

> **§2026-06-04 vacuity sweep.** A strict re-audit found 14 *vacuous* (decorative,
> can-never-fire) declarations and fixed them: (1) the 9 `core-node` aggregates
> measured all-zero because the complexity metric extractor used a non-existent
> TS API + a SourceFile without `setParentNodes` — every metric silently read 0;
> fixed, thresholds re-tuned against real values. (2) The 5 `smart-ctor`
> declarations were **removed** — the smart-ctor checker only binds `class`
> value-objects, but Stele's brands are string type aliases, so they never ran;
> their "deny raw construction" intent is enforced by the 5 `*_USES_BRANDED_TYPE`
> invariants. Mechanism count is therefore **13**, not 14. (3) Symmetric
> zero-binding guards were added to the `trace-policy` stage and the `type-policy`
> `requireFieldTypes` branch, matching the type-state guard — an error-severity
> structural declaration that binds 0 targets now fails instead of passing green.

This document tracks which of Stele's contract mechanisms are exercised against
which **workspace packages**, in this repository's own `contract/main.stele` +
`contract/generated/ddd-typedriven.stele`. (Originally 14 advertised mechanisms;
smart-ctor removed 2026-06-04 as inapplicable to string-alias brands → **13**.)

The goal of the self-dogfooding plan (Phases 0–6) was to take every row
from `❌ none` to at least one `✅` cell. After Phase 6 close-out, **every
row has at least one ✅** — see the summary at the bottom.

## How to read this matrix

- Rows = the 14 mechanisms (the README's "12 unused" list + the
  pre-existing 2 = `invariant` and `checker`).
- Columns = workspace packages grouped by role (full live list:
  `pnpm -r ls --json --depth -1`, 18 packages + 1 monorepo root).
- Cells:
  - `✅ N` — N declarations apply to that package.
  - `⚠️ partial` — declaration exists but does not yet enforce on
    real call sites (compile-time gate present but evaluator silent).
  - `❌` — no declaration applies to that package.

Targets are inferred from each declaration's `(target …)` / `(target-scope …)`
/ `(scope …)` field; some declarations span multiple packages (counted in
each affected column).

## Column groups

For brevity the 18 packages are grouped:

- **core** = `@stele/core`
- **cli** = `@stele/cli`
- **plugin** = `@stele/claude-code-plugin` (+ `@stele/agent-hooks`)
- **backends** = `@stele/backend-{python,typescript,go,rust,java}`
- **eval** = `@stele/{call-graph-core,trace-evaluator,type-state-evaluator,effect-evaluator,type-driven-evaluator,architecture-core}`
- **infra** = `@stele/{mcp-server,github-action,conformance-tests}`

The single monorepo root (`stele-monorepo`) is not a publishable
package and is excluded.

## Matrix

| Mechanism                | core   | cli    | plugin | backends | eval   | infra | Total |
|--------------------------|--------|--------|--------|----------|--------|-------|-------|
| **invariant**            | ✅ 18+ | ✅ 9+  | ✅ 5+  | ✅ 7+    | ✅ 1   | ❌    | 48    |
| **checker**              | ✅ 18+ | ✅ 9+  | ✅ 5+  | ✅ 7+    | ✅ 1   | ❌    | 48    |
| **boundary** (code-shape)| ✅ 1   | ✅ 1   | ❌     | ❌       | ❌     | ❌    | 2     |
| **class-shape**          | ✅ 1   | ✅ 1   | ❌     | ❌       | ❌     | ❌    | 2     |
| **function-shape**       | ✅ 1   | ❌     | ✅ 2   | ❌       | ❌     | ❌    | 3     |
| **type-policy**          | ✅ 1   | ❌     | ❌     | ❌       | ❌     | ❌    | 1     |
| **file-policy**          | ❌     | ❌     | ✅ 1   | ❌       | ❌     | ❌    | 1     |
| **architecture**         | ✅ 1   | ✅ 1   | ✅ 2   | ✅ 5     | ✅ 6   | ✅ 3  | 18    |
| **core-node**            | ✅ 4   | ✅ 5   | ❌     | ❌       | ✅ 1   | ❌    | 10    |
| **branded-id**           | ✅ 4   | ✅ 1   | ❌     | ❌       | ❌     | ❌    | 5     |
| **smart-ctor**           | —      | —      | —      | —        | —      | —     | 0 (removed 2026-06-04) |
| **trace-policy**         | ✅ 1   | ✅ 3   | ❌     | ❌       | ❌     | ❌    | 4     |
| **type-state**           | ✅ 1   | ✅ 2   | ❌     | ❌       | ✅ 1   | ❌    | 4     |
| **effect-policy**        | ✅ 2   | ✅ 1   | ✅ 1   | ❌       | ❌     | ❌    | 4     |
| **TOTAL declarations**   | —      | —      | —      | —        | —      | —     | 153   |

### Notes on cells

- **invariant / checker** — 48 declarations across `contract/main.stele`,
  classified by the package their checker targets:
  - `@stele/core`: backend registry (7), manifest (4), exit codes / errors,
    operator registry, CDL grammar, structural types, core engine purity,
    no-cjs-require, esm-relative-imports-keep-js, default-protected,
    bash-extractors-shared (when shared module is in core path), no-bare-locale-compare.
  - `@stele/cli`: CLI command set, exit code enum, branded-id RuleId/SHA256/
    ContractPath/CommandName/PackageName checks, CLI io-through-path-utils,
    phase-language-config, fix-hint analysis branch.
  - `@stele/claude-code-plugin`: HOOKS_FAIL_CLOSED, HOOKS_REGISTRATION_COMPLETE,
    HOOK_ENTRYPOINTS_FAIL_CLOSED, DEFAULT_PROTECTED_CONSISTENT,
    BASH_EXTRACTORS_SHARED, PROTECTED_PATTERN_SAFE.
  - `@stele/backend-*`: ALL_BACKENDS_COMPILE + 5 backend-presence invariants
    (one per language) + DETERMINISTIC_GENERATION + PATH_NO_TRAVERSAL.
  - `@stele/*-evaluator`: ALL_EVALUATORS_COMPILE (and STRICT_MODE_DEFAULT_IN_CI
    which gates the CI workflow that runs every evaluator).

- **boundary** — `core-no-fs-write-from-non-manifest` (deny `node:fs`/
  `node:fs/promises` imports outside `manifest/**` + allow-listed sites in
  `@stele/core`) and `cli-commands-no-direct-fs-write` (deny `writeFileSync` /
  `appendFileSync` in `@stele/cli/commands` outside `init.ts` + `design/**`).

- **class-shape** — `cli-command-error-shape` (`@stele/cli`'s
  `CliCommandError` must extend `Error` + have `exitCode` field) and
  `core-operator-registry-aggregate-shape` (auto-generated from the DDD
  profile, targets `@stele/core`'s `InMemoryOperatorRegistry` —
  `register/get/has/list` methods + `#operators` field).

- **function-shape** — `hook-fail-closed-v2`, `stop-validate-fail-closed`
  (plugin scripts must call `failClosed` / `blockStop` from inside `main()`)
  and `write-atomic-has-rename` (`@stele/core`'s `writeAtomic` must call
  `rename` — the atomic-write contract).

- **type-policy** — `no-any-in-core` denies the `any` type annotation
  across `@stele/core/src/**`.

- **file-policy** — `hook-scripts-shebang` requires the four hook entry-
  point scripts (`pre-tool-protect`, `stop-validate`, `observation-hook`,
  `lifecycle-context`) to begin with `#!/usr/bin/env node`.

- **architecture** — 18 architecture blocks emitted by the DDD design
  generator from `contract/design/profile.yaml`. Each names a layered
  module (`ddd-core`, `ddd-cli`, `ddd-architecture`, the 5 backend `ddd-
  backends-*`, plugin / hooks / mcp / github-action, the 5 evaluator
  packages `ddd-call-graph-core`, `ddd-trace-evaluator`, etc.) plus the
  cross-cutting `ddd-context-map` integration layer.

- **core-node** — 10 aggregate-root nodes generated from the DDD profile
  (`core-operator-registry-aggregate`, `core-invariant-validator-aggregate`,
  `core-contract-loader-aggregate`, `core-manifest-engine-aggregate`,
  `cli-check-orchestrator-aggregate`, `cli-code-shape-evaluator-aggregate`,
  `cli-design-diff-engine-aggregate`, `cli-cli-program-factory-aggregate`,
  `cli-design-profile-validator-aggregate`, `architecture-architecture-
  evaluator-aggregate`). Each emits `sloc`, `public-method-count`, and
  `max-cyclomatic` metrics.

- **branded-id** / **smart-ctor** — 5 brands (`RuleId`, `ContractPath`,
  `Sha256`, `PackageName`, `CommandName`) and 5 paired smart constructors.
  Targets: `RuleId` / `Sha256` / `ContractPath` are produced and consumed
  in `@stele/core`; `CommandName` / `PackageName` are produced in
  `@stele/cli`'s command-registration site. Five paired self-protection
  invariants (`RULE_ID_USES_BRANDED_TYPE`, `SHA256_USES_BRANDED_TYPE`,
  `CONTRACT_PATH_USES_BRANDED_TYPE`, `COMMAND_NAME_USES_BRANDED_TYPE`,
  `PACKAGE_NAME_USES_BRANDED_TYPE`) live under the invariant row above.

- **trace-policy** — 4 declarations:
  - `FS_WRITES_VIA_WRITE_ATOMIC` — `@stele/core` writes route through
    `writeAtomic` (currently emitting 1 `path_exceeded_max_depth` error,
    see open follow-ups below).
  - `CHECK_PREPARE_VIA_LOAD_CONTRACT` — `@stele/cli`'s check pipeline
    must call `loadContract` before `prepareCheckContextWithContract`.
  - `GENERATE_VIA_COORDINATOR` — `@stele/cli`'s generate must call
    `coordinateGeneration` before any `writeAtomic`.
  - `APPROVE_VIA_RESOLVE_APPROVED_BY` — `@stele/cli`'s design-approve
    must call `resolveApprovedBy` before any `writeFileSync`.

- **type-state** — 4 lifecycles. **As of 2026-06-03 all four genuinely
  bind at runtime** (✅, not ⚠️). Two enforcement layers now hold: (1)
  **compile-time** state-keyed `StateBrand<S>` (`*.test-d.ts` pinning), and
  (2) the **runtime** call-graph evaluator, which previously found 0 call
  sites. The runtime gap was closed by teaching the TS extractor to record
  FREE-FUNCTION transition calls (`lockManifest(m)`, `signApproval(a)`) — not
  just `receiver.method()` — to read intersection-alias brand state via
  `aliasTypeArguments`, and to match the lifecycle type by name across the
  package boundary (cross-package imports resolve through a sibling's dist
  `.d.ts`, so symbol identity breaks). The evaluator trusts these
  `viaFreeFunction` inferences (the extractor already verified callee-name +
  argument-type), so cross-package transition calls whose call-graph edge
  target is an `extern:` node are no longer dropped. Targets:
  - `MANIFEST_LIFECYCLE` — `@stele/core` (`Unloaded→Loaded→Locked→Verified`)
  - `APPROVAL_LIFECYCLE` — `@stele/cli` (`Drafting→IdentityChecked→Signed`)
  - `DESIGN_PROFILE_LIFECYCLE` — `@stele/cli` (`Raw→Validated→Hashed`)
  - `CALLGRAPH_LIFECYCLE` — `@stele/call-graph-core` (`Empty→Building→Built→Cached`)

- **effect-policy** — 4 policies, fail-closed per-policy by
  `target-scope` membership (Closeout 1, 2026-05-25). Unresolved-call
  sites OUTSIDE every policy's scope emit nothing because no policy
  cares; sites INSIDE an active scope are unconditionally error-severity.
  Policies:
  - `CORE_IS_PURE_OR_FS_READ` — `@stele/core` `(allow-only fs.read fs.write crypto.hash)`
  - `MANIFEST_LEAVES_ARE_PINNED` — `@stele/core/manifest/hash-manifest.ts`
  - `HOOK_NO_NETWORK` — `@stele/claude-code-plugin/scripts/*.js`
  - `GENERATOR_NO_NETWORK_OR_CHILD_PROCESS` — `@stele/cli/commands/generate.ts`
  Plus 1 `effect-declarations` block (9 effects), `@stele:effects`
  JSDoc annotations across `@stele/core` and `@stele/cli/commands/generate.ts`
  source (including 6 Closeout 1 Category B closed-world declarations
  added 2026-05-25), and 3 `effect-suppression` declarations (the 3
  atomic-writer leaves).

## Coverage summary

After Phase 6 close-out:

- **13 / 13 mechanisms have at least one genuinely-binding ✅** (smart-ctor
  removed 2026-06-04 as inapplicable; was 14/14 with one decorative).
- ~133 binding declarations across the contract surface (was 35 invariants
  before the plan; -5 smart-ctor removed 2026-06-04).
- As of 2026-06-04 **no mechanism is vacuous**: the 9 all-zero core-node
  aggregates now measure real values, and every error-severity structural
  family (type-state, trace-policy, effect-policy, class/function/type/file-shape,
  boundary) fails on a zero-binding target rather than passing green.

**Decisions 2026-06-04 (maintainer-adjudicated):**
- 3 invariants promoted warning→error: `CDL_NO_SINGLE_QUOTES`,
  `VERSIONS_PINNED_TOGETHER`, `INLINE_VERSION_SYNC` (all currently green).
- `DETERMINISTIC_GENERATION` description aligned to its heuristic implementation
  (true byte-stability is enforced by the manifest hash + pure generator, not by
  this scan); + negative test added.
- Negative tests backfilled for the 6 previously-unproven invariants
  (ALL_BACKENDS_COMPILE, NO_HARDCODED_SECRETS, PATH_NO_TRAVERSAL,
  VERSIONS_PINNED_TOGETHER, NO_BARE_LOCALE_COMPARE, BACKEND_REGISTRY_HAS_*×4) and
  for the trace/effect/type-policy zero-binding guards.
- **Accepted WEAK (deliberately not changed):** (a) `branded-id` entity-scope
  NOT activated — field/param misuse detection is heuristic + noisy and is
  already covered genuinely by the 5 `*_USES_BRANDED_TYPE` invariants; the
  branded-id declarations still bite on type deletion/rename. (b) 4 thin-wrapper
  `core-node` thresholds left generous — the metric binds the delegating entry
  symbol, not the aggregate body; the paired class-shape companion enforces the
  member set, so these are coarse growth-guards, not vacuous. Retargeting to the
  load-bearing symbol is a future design improvement.
- As of 2026-06-03 **no mechanism is `⚠️ partial`**. `type-state` was the
  last partial row; all 4 lifecycles now bind at runtime (see the type-state
  note above). A **zero-binding guard** in `check-stages-type-state.ts` now
  emits `typestate.<id>.zero_binding` (error) for any error-severity
  declaration the evaluator binds to 0 call sites — a runtime structural
  constraint can no longer report a silent green while protecting nothing.

## Open Phase 7 follow-ups (declarations not yet landed)

- **9 of 10 aggregate-root class-shapes are deferred** — every aggregate
  except `operator-registry` targets a free function, and the class-shape
  evaluator only binds to real `class` declarations. Phase 7 must choose
  between (a) wrapping each free-function aggregate in a stateless service
  class, or (b) extending the TS class-shape extractor to bind against
  module-level functions. See `phase-6-aggregate-root-shapes.md` + the
  README decision log close-out for the per-aggregate target list.

- **Type-state evaluator binds zero call sites.** ✅ **RESOLVED 2026-06-03.**
  The evaluator now fires on free-function transition calls in addition to
  `receiver.method(...)`, reads intersection-alias brand state, and matches
  the lifecycle type by name across the package boundary. All 4 lifecycles
  bind at runtime; `stele check` is green honestly (not vacuously). No
  production refactor was needed — the existing free-function lifecycle APIs
  (`lockManifest`, `signApproval`, `startBuilding`, …) are the bound call
  sites. A zero-binding guard prevents silent regression to 0 bindings.

- **Phase 2 deferred class-shapes / type-policy** — `MANIFEST_ENGINE_SHAPE`,
  `VIOLATION_REPORT_SHAPE`, `RULE_ID_FIELDS_BRANDED` all target
  TypeScript type aliases. Phase 7 must either refactor the targets to
  real classes or extend the TS class-shape extractor to bind against
  `type` aliases.

- **Phase 3 deferred trace-policies** — `EVALUATOR_VIA_EXTERN_REGISTRY`
  (DI seam blocks call-graph edge) and `BACKEND_LOAD_VIA_REGISTRY` (intent
  is an import boundary, not a call-graph trace; should be re-landed as a
  code-shape `(boundary …)` declaration).

- **1 known `stele check` error remains:**
  `trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth`. The trace
  evaluator hits its default max-depth cap when walking from the file-
  IO leaf back through the cached call graph. Pre-existing before the
  Phase 5 sub-agent ran; not blocking on documentation work.

## Cross-references

- Self-dogfooding plan: `docs/design/self-dogfooding/`
- CDL spec: `docs/spec/cdl.md`
- Phase summary: `docs/internal/self-dogfooding-2026-Q2.md`
- Live contract: `contract/main.stele` + `contract/generated/ddd-typedriven.stele`
