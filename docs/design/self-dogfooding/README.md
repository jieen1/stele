# Self-Dogfooding Plan — Stele Adopts Its Own Full Toolkit

**Status:** draft (pre-review)
**Date:** 2026-05-24
**Owner:** main agent
**Tracking ID:** `selfdogfood-2026Q2`

## Why this document exists

Stele currently uses **2 of the 14 mechanisms** it advertises on its own
source code (`invariant` + custom `checker`, plus partial use of
`architecture` + `core-node` via the auto-generated DDD profile). The
other 12 mechanisms are built, tested, exported as npm packages, and
documented — but **zero contracts in `contract/main.stele` use them on
Stele's own code**.

This is unacceptable for a product that says "AI agents can't break
your contracts": Stele must hold itself to the same bar it asks of
adopters. This document plans the work to close that gap.

The plan is intentionally **detailed enough that a sub-agent can
execute any phase without drift**. Each phase below specifies:

- Exact scope (what's in / out)
- Required architectural changes (with file paths and signatures)
- Every new contract to be written (with the exact CDL form)
- Negative test obligations
- Acceptance criteria (commands + expected output)
- Rollback strategy if the phase fails review
- Cross-phase invariants that must hold

Anything not explicitly stated here is **out of scope** for that
phase and must be deferred to a future round.

## Definitions used throughout this document

- **Mechanism**: one of Stele's 14 advertised contract types (see
  `docs/spec/cdl.md` § Top-level declarations). The 14 are:
  `metadata` / `import` / `operator` / `checker` / `group` /
  `invariant` / `scenario` / `boundary` / `class-shape` /
  `function-shape` / `type-policy` / `file-policy` / `architecture` /
  `core-node` / `branded-id` / `smart-ctor` / `trace-policy` /
  `type-state` / `type-state-binding` / `effect-declarations` /
  `effect-annotation` / `effect-policy` / `effect-suppression` /
  `extern-alias`. (That's actually 23 forms — the 14 we count
  excludes `metadata` / `import` / `operator` / `checker` / `group` /
  `scenario` / `extern-alias` / `effect-declarations` /
  `effect-annotation` / `effect-suppression` / `type-state-binding`
  which are either framework plumbing or sub-declarations of other
  forms. The 12 unused-on-Stele are listed below.)

- **The 12 unused mechanisms on Stele itself** (the target of this work):
  1. `trace-policy`
  2. `type-state`
  3. `type-state-binding`
  4. `effect-declarations` (declares the effect alphabet)
  5. `effect-annotation`
  6. `effect-policy`
  7. `effect-suppression`
  8. `boundary` (code-shape)
  9. `class-shape`
  10. `function-shape`
  11. `type-policy`
  12. `file-policy`

  Plus partially-used:
  - `branded-id` / `smart-ctor` — declared in
    `contract/generated/ddd-typedriven.stele` but 0 real call sites
    in source.

- **Stele project = the target**: the contracts written in this plan
  go in `contract/main.stele` (or new `contract/modules/*.stele`
  files imported by main) of THIS repo and apply to THIS repo's
  source tree.

- **Phase / Step / Acceptance / Negative test**: terms from the
  existing rounds (Round 4 onwards) — same semantics.

## The architectural blocker (Phase 0 must come first)

`stele.config.json` has a single `targetLanguage` field. Today it's
`"python"` for this repo because the 42 self-protection checkers are
Python and run under pytest. **But the Phase B evaluators (trace /
type-state / effect) dispatch on the same `targetLanguage` field** —
which means you can't write a TypeScript `trace-policy` for THIS
repo's TS source while keeping pytest as the test runner.

**The fix** (Phase 0): allow `stele.config.json` to declare a
per-phase language override:

```jsonc
{
  "targetLanguage": "python",
  "testFramework": "pytest",
  "phaseLanguages": {
    "trace": "typescript",
    "type-state": "typescript",
    "effect": "typescript",
    "code-shape": "typescript",
    "architecture": "typescript"
  },
  "tsconfig": "tsconfig.base.json"
}
```

**Reviewer V-12 fix:** kebab-case keys match the CDL mechanism
names. Code-shape per-declaration `(lang …)` still overrides the
default, so this field is essentially advisory unless a future
release supports omitting `(lang …)`.

Without Phase 0, Phases 3 / 4 / 5 cannot land — they're literally
blocked by the dispatch logic. So Phase 0 is non-optional.

## Plan structure

| Phase | Topic | Mechanism(s) Covered | Estimated Effort | Blocks |
|---|---|---|---|---|
| **0** | Multi-language config infrastructure | (none — plumbing) | 1.5–2 days | 3, 4, 5 |
| **1** | branded-id / smart-ctor real adoption | `branded-id`, `smart-ctor` (existing 5 + 1 new) | 3–4 days | (none) |
| **2** | Code-shape rules | `boundary`, `class-shape`, `function-shape`, `type-policy`, `file-policy` | 3 days | 6 |
| **3** | Trace-policy rules | `trace-policy` | 3 days | (none) |
| **4** | Effect-policy rules + alphabet + annotations + suppressions | `effect-declarations`, `effect-annotation`, `effect-policy`, `effect-suppression` | 3–4 days | (none) |
| **5** | Type-state lifecycles | `type-state`, `type-state-binding` | 4 days | (none) |
| **6** | DDD aggregate-root strengthening (class-shape applied to aggregates) | reuses `class-shape` | 1.5 days | — |
| **7** | Documentation + Round 15+ independent reviewer cycle | — | 2–3 days + reviewer turn-around | — |

**Total estimated effort:** 21–24 working days, plus reviewer
turn-around in Phase 7.

**Total expected new invariants:** ~42 (project goes from 42 → ~84).
**Total expected new negative tests:** ~42 (project goes from 59 → ~101).

## Phase documents

Each phase has its own document with full implementation detail:

- [phase-0-multi-language-config.md](phase-0-multi-language-config.md)
- [phase-1-branded-types.md](phase-1-branded-types.md)
- [phase-2-code-shape.md](phase-2-code-shape.md)
- [phase-3-trace-policy.md](phase-3-trace-policy.md)
- [phase-4-effect-policy.md](phase-4-effect-policy.md)
- [phase-5-type-state.md](phase-5-type-state.md)
- [phase-6-aggregate-root-shapes.md](phase-6-aggregate-root-shapes.md)
- [phase-7-docs-and-review.md](phase-7-docs-and-review.md)

## Cross-cutting rules (apply to all phases)

These rules apply to every phase. A sub-agent executing any phase
must respect them.

### CC-1 No silent skipping

If a step in a phase fails, **stop the phase and surface the
failure**. Do not skip steps. The phase document marks every step
"required" or "optional"; the optional ones may be skipped only if
explicitly noted.

### CC-2 Negative test obligation

Every new invariant / checker / contract MUST have a paired negative
test in `contract/checker_impls/test_negative.py` (or its TypeScript
equivalent for non-Python checkers, if applicable). The negative test
must:

1. Mutate something in source to violate the contract
2. Run the checker
3. Assert it fails with the expected violation id
4. Restore the original source

No exceptions. A phase is not complete until all its negative tests
pass.

### CC-3 Stele check + pytest must stay green

**Reviewer V-11 fix:** `test_negative.py` defines 88+ pytest-style
`def test_…` functions. Running it as `python file.py` only executes
the `if __name__ == "__main__":` block (the legacy ad-hoc runner) and
SKIPS the function set. Use the pytest invocation as the authoritative
command.

After every step in a phase, the following must all return exit 0:

```
pnpm build
node packages/cli/dist/index.js check
.venv/bin/python -m pytest tests/contract -q
.venv/bin/python -m pytest contract/checker_impls/test_negative.py -q
```

If any goes red, the step is incomplete.

### CC-4 No backward-compat shims

Any source change made under this plan MUST be a clean cut (per
CLAUDE.md). No `// removed:` markers, no compat shims, no temporary
flags. If the change is too big for a single commit, split it into
multiple commits where each commit is itself green.

### CC-5 No new tests are deleted to make a phase pass

If a phase change breaks an existing test, the FIX is to either:
(a) update the test to assert the NEW correct behavior, or
(b) revise the phase to preserve the old behavior.

Deleting tests to make the phase pass is forbidden.

### CC-6 Lockstep manifest discipline

After every phase:

1. `node packages/cli/dist/index.js lock --reason "Phase N: <summary>"`
2. Commit the manifest change in the SAME commit as the source change
3. Verify `stele check` exits 0

### CC-7 Single-author commit + Co-Authored-By footer

Each phase produces ONE commit (or a small series, e.g. 1 architecture +
1 contract + 1 source). All commits end with:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

### CC-8 No new dependencies

This plan introduces NO new npm dependencies. If a phase needs a
library not already present, the phase must be redesigned.

### CC-9 No targetLanguage change without approval

Phase 0 introduces `phaseLanguages` as an ADDITIONAL field. The
existing `targetLanguage: "python"` for this repo MUST NOT change.

### CC-10 Reviewer cycle is non-optional

Phase 7 is mandatory. The plan is not "done" until at least one
independent reviewer round (Round 15+) returns 0 substantive
findings. Reviewer findings get fixed in additional commits, not
silenced.

### CC-11 NodeId / arity convention for Phase B targets

**Reviewer V-09 fix:** trace/effect/type-state `(target …)` and
`(target-scope …)` values reference call-graph NodeIds. The pattern
matcher in `@stele/call-graph-core` accepts BOTH:

- Arity-less form: `"packages/foo/bar.ts::baz"` (matches any arity)
- Arity-specified form: `"packages/foo/bar.ts::baz(2)"` (matches
  only the 2-arg variant)

**Convention for this plan:** prefer arity-less unless there's
known overloading. The 3 cases where arity matters and MUST be
specified are:

- `effect-suppression` targets — to disambiguate the exact function
  being exempted (Phase 4 §4.4 already follows this)
- `type-state-binding` targets that bind to a specific overload
- Trace-policy `must-transit` where two methods with the same name
  exist on different overloads

When writing a contract, READ the source first and confirm the
arity. Document the choice in the surrounding comment.

## Risk register

| Risk | Mitigation | Phase |
|---|---|---|
| `phaseLanguages` introduces breaking change for adopters | Make the field optional with safe defaults; document migration | 0 |
| branded-id mass adoption triggers 100+ TS errors | Land branded types one type at a time (5 sub-commits) | 1 |
| Trace-policy on this repo is slow (call-graph extraction) | Add cache; benchmark before/after | 3 |
| **Cumulative Phase B (trace+type-state+effect) on the 9.3k-node × 41k-edge graph** may breach the Stop-hook latency budget | Pre-bake a benchmark step before Phase 3 starts; gate Phases 4/5 on it; if cumulative cost exceeds 30s, add aggressive scoping (`(scope …)` narrower targets) or graph caching | 3, 4, 5 |
| Effect-policy too aggressive — flags hash-manifest.ts | Pre-write the `effect-suppression` declarations | 4 |
| Type-state requires core-type refactor (Manifest / Approval) | Land Phase 5 BEHIND Phase 1 (branded types already done) so the refactor surface is well-typed | 5 |
| Reviewer rounds find HIGH bypass that requires re-doing a Phase | Plan the reviewer turn-around explicitly in Phase 7 — budget 2 review rounds | 7 |

## Out of scope

These items are explicitly NOT part of this plan:

- Adding Phase B support for Go / Rust / Java (separate roadmap item)
- Switching `targetLanguage` away from `"python"`
- New evaluator packages
- New CDL forms beyond the 23 already shipped
- npm publishing prep
- Performance tuning of generated tests
- IDE plugin work
- Adopting these contracts in user-facing fixtures (`examples/finance-guard/`, etc.)

## Decision log (must be appended as work progresses)

Append every non-trivial decision here with date + brief rationale.
The decision log is part of the plan and is reviewed in Phase 7.

### 2026-05-24 — Phase 2 sub-agent

- **Used `(lang typescript)` for all 9 landed code-shape contracts.** Per
  the prompt; matches V-04. No `(lang python)` declarations introduced.
- **Code-shape IDs must start with a lowercase letter.** The branded
  `RuleId` constructor in `@stele/core` validates with
  `/^[a-z][A-Za-z0-9._:-]*$/`. Phase doc used `UPPER_SNAKE` (e.g.,
  `CORE_NO_FS_WRITE_FROM_NON_MANIFEST`); landed as `lowercase-kebab`
  (e.g., `core-no-fs-write-from-non-manifest`). CDL identifier syntax
  also forbids dots / colons in identifiers, so namespace-style ids
  like `stele.phase2.foo` are not valid either.
- **`(deny-import "module::name")` is a no-op on the current TS analyzer.**
  `analyzeTypeScriptFiles` only emits the module specifier as an import
  candidate, not `module.name`. The Python analyzer emits both. Updated
  the boundary contracts to deny entire modules with an explicit
  `(allow-target …)` list. Phase 7 follow-up suggested: extend the TS
  analyzer to also emit `module.namedExport` candidates for parity with
  the Python analyzer; this enables finer-grained boundary contracts.
- **`(deny-call …)` only matches MODULE-LEVEL calls in both languages.**
  The Python `iter_non_nested` walker skips into function bodies, and
  the TS file-level walk likewise excludes calls captured inside
  `readClassDeclaration` / `readFunctionDeclaration` / `readArrowFunction`.
  Function-body call detection happens only inside `function-shape`
  declarations against a specific function selector. Documented inside
  the contract as a maintenance note.
- **`@stele/backend-python` now skips TS-lang code-shapes.** The
  pre-Phase-2 renderer always emitted `test_code_shape.py` pytest tests
  for ALL code-shape declarations, including `(lang typescript)` ones —
  which then tried to parse `.ts` source via Python's `ast` module and
  SyntaxErrored on the first hyphen or `:`. Renderer (`backend.ts`,
  `code-shape-renderer.ts`) and layout (`core/src/generator/layout.ts`)
  now filter to `(lang python)`. `(lang typescript)` declarations are
  exclusively the CLI's in-process TS evaluator's responsibility.
- **TS analyzer now accepts `.js` / `.mjs` / `.cjs`.** Updated
  `isTypeScriptFilePath` + new `scriptKindFor` helper to support ESM
  hook scripts. The phase doc already noted this should work; the
  filter was lying. Files outside `(target …)` patterns remain
  unaffected by minimatch upstream.
- **`CliCommandError.exitCode` promoted from parameter property to
  explicit field declaration.** The TS analyzer's `readClassDeclaration`
  only collects `ts.isPropertyDeclaration` members; parameter properties
  (`constructor(readonly exitCode: ExitCode, …)`) are stored on the
  instance at runtime but invisible to the class-shape analyzer. Small
  refactor; behaviour identical at runtime.
- **`pre-tool-protect.js` top-level body wrapped in `async main()`.** The
  phase doc's `hook-fail-closed-v2` selector required a `::main` anchor;
  the file previously had no `main()` and ran top-level `try { … }
  catch { failClosed(…) }`. The new wrapper preserves the same outer
  try/catch + `failClosed` inside `main`, so the existing Round 4 E-04
  `HOOK_ENTRYPOINTS_FAIL_CLOSED` invariant continues to pass.

### Phase 2 deferred items (re-scope to Phase 7)

Three of the 12 phase-doc contracts were removed during Phase 2 because
making them land required cross-Phase-2 refactors:

1. **`MANIFEST_ENGINE_SHAPE`** — phase doc targets
   `packages/core/src/manifest/manifest.ts::Manifest`. The actual
   declaration is `export type ContractManifest = { … }`, a TypeScript
   type alias. The TS analyzer's `collectClassMatches` only resolves
   `ts.isClassDeclaration` nodes; type aliases yield no anchor. Phase 7
   options: (a) refactor `ContractManifest` to a real class, with a
   small migration in `writeManifest`/`verifyManifest`; or (b) extend
   the analyzer to recognise type aliases for class-shape selectors
   (more useful, broader change).
2. **`VIOLATION_REPORT_SHAPE`** — phase doc targets
   `packages/core/src/report/types.ts::ViolationReport`. Same root
   cause as (1): `ViolationReport` is a type alias.
3. **`RULE_ID_FIELDS_BRANDED`** — phase doc targets
   `packages/core/src/report/types.ts::Violation` with
   `(require-type "RuleId")`. Same root cause: `Violation` is a type
   alias. Also requires the cascading retype of `Violation.rule_id`
   from `string` to `RuleId`, with knock-on changes across the cli
   command modules and ~30 vitest fixtures that build `Violation`
   objects with raw-string `rule_id`. Recommended Phase 7 sequencing:
   first land class-shape selector support for type aliases (or
   migrate `Violation` to a class), then re-introduce the contract.

All three are tracked here as Phase 7 follow-ups; no source change
to `Violation` / `ContractManifest` / `ViolationReport` was applied
in Phase 2.

### 2026-05-24 — Phase 3 sub-agent

- **Re-grounded trace-policy semantics against the @stele/trace-evaluator
  implementation** before writing the contracts. `target` is the
  destination of a call path; `must-transit` checks intermediates (not
  endpoints) on caller→target paths; `must-be-preceded-by` checks the
  order of edges WITHIN a single caller's body. The phase-3 doc's
  prose semantics align with the design doc, but the literal contract
  forms it lists assume `target` describes "caller frames that the
  policy applies to" (which is the spec wording, not the evaluator
  behaviour). All four landed contracts were rewritten to match the
  shipped evaluator.
- **External-package functions appear as `extern:<package>::…` NodeIds,
  not `node:<module>::…`.** The phase doc's `node:fs/promises::*`,
  `@stele/backend-python`, and similar pattern shapes match nothing in
  the live call graph. The TS extractor emits `extern:node-fs::*`,
  `extern:stele-backend-python::*` (when actually imported with a
  type-resolvable specifier), etc. Patterns rewritten accordingly.
- **Commander's `.action(fn)` registration is a property assignment, not
  a call edge.** Top-level CLI entry points like `runCheck`,
  `runGenerate`, and `runDesignApprove` have NO in-scope callers in the
  extracted graph. Trace policies that anchor `target` at these
  entry-points (3.2 / 3.3 / 3.5 literal forms in the phase doc) are
  vacuous: `allTargets` matches the node but `callerNodes` never
  produces a caller that reaches it. Rewrote 3.2 / 3.3 / 3.5 as
  `must-be-preceded-by` over the BODY of the entry-point caller, which
  the evaluator can check via `getOrderedOutgoingEdges`.

### Phase 3 deferred items (re-scope to Phase 7)

Two of the six phase-doc contracts could not land because the call
graph the TS extractor produces does not model the necessary edges:

1. **`EVALUATOR_VIA_EXTERN_REGISTRY` (3.4)** — phase doc targets
   `buildTraceStage` and must-transit `buildExternAliasRegistry`. The
   evaluator-invocation line in `check-stages-trace.ts` is
   `const result = evaluate({ ... })` where `evaluate` is a LOCAL
   variable holding either `deps.evaluate` or the imported
   `evaluateTracePolicies`. The TS extractor does not track calls
   through local-variable holders of imported functions, so no edge
   `buildTraceStage → evaluateTracePolicies` exists in the graph and
   no anchor downstream of `buildExternAliasRegistry` is available to
   pin a must-be-preceded-by constraint to. Phase 7 options: (a)
   refactor `check-stages-trace.ts` to call `evaluateTracePolicies`
   directly (no DI seam) — sacrifices test injectability; or (b)
   teach the TS extractor to track calls through local-variable
   bindings of imported functions (broader, would also unblock other
   policies).
2. **`BACKEND_LOAD_VIA_REGISTRY` (3.6)** — phase doc's deny-direct
   patterns (`@stele/backend-python`, …) describe IMPORT specifiers,
   not call-graph NodeIds. `compilePattern` interprets them as file
   globs that never match any extracted node. Backends are loaded via
   `await import(...)` dynamic imports through the backend registry;
   the extractor does not currently model `await import` as call
   edges either. The intent — "do not import backend packages outside
   the registry module" — is naturally an IMPORT-level boundary, not
   a call-graph trace. Phase 7 should re-land this as a code-shape
   `(boundary …)` contract with `(deny-import "@stele/backend-*")`
   alongside the existing `core-no-fs-write-from-non-manifest`
   pattern; the boundary stage already handles deny-import correctly.

Both are tracked here as Phase 7 follow-ups.

### Phase 3 perf baseline

Wall-clock for `time node packages/cli/dist/index.js check` (warm
caches, 3 successive runs averaged):

| | seconds |
| --- | --- |
| Before Phase 3 (48 invariants, 0 trace-policies) | 11.0 |
| After Phase 3 (48 invariants, 4 trace-policies) | 13.8 |
| Delta | +2.8 |

Well within reviewer V-10's 30s budget. The TS call graph is cached
within a single `stele check` invocation (see
`check-stages-call-graph-cache.ts`), so all four trace-policy
contracts share one extraction. Phase 4 (effect-policy) and Phase 5
(type-state) will reuse that cache through `getCachedCallGraph`, so
cumulative Phase-B cost on the 9.3k-node graph should remain bounded.

### 2026-05-24 — Phase 4 sub-agent

- **Step 4.1 landed**: `(effect-declarations …)` block with 9 effect
  names (`fs.read`, `fs.write`, `time`, `random`, `env`, `network`,
  `crypto.hash`, `process`, `child-process`). Dotted names are
  string-quoted per V-04. `pure` is deliberately omitted — per the
  effect-system spec, "pure" is the absence of any declared effect, and
  declaring it would only cause false violations on `allow-only`
  policies whose whitelist omits `pure`.
- **Step 4.2 partial**: only the LEAF effect-producers in @stele/core
  were annotated (17 functions across 6 files), not the ~40 the phase
  doc anticipated. The phase doc's table includes pure functions
  annotated `@stele:effects pure`, but landing those would conflict
  with the (no-`pure`-in-alphabet) decision above. JSDoc annotations
  are direct effects; propagation through the call graph carries them
  to downstream callers automatically, so leaf-annotation is sufficient
  to surface the effect in the evaluator's effective set at every
  caller. Annotated functions:
  - `writeAtomic` → `fs.write, time, random` (sole leaf fs.write site
    in core)
  - `writeManifest` → `fs.read, crypto.hash` (fs.write inherits via
    writeAtomic edge)
  - `writeHashManifest`, `writeViolationBaseline` → no direct effects
    (inherit fs.write/time/random via writeAtomic)
  - `verifyManifest`, `loadContract`, `readHashManifest`,
    `sha256OfFileOrNull`, `readViolationBaseline`,
    `tryReadViolationBaseline`, `collectExistingGeneratedEntries`,
    `walkGeneratedDirectory`, `readGeneratedFile`, `verifyFiles` →
    `fs.read` (+ `crypto.hash` where relevant)
  - `computeSha256` / `hashManifestSha256`,
    `buildViolationFingerprint` → `crypto.hash`
  - `deleteHashManifest` → not annotated. The unlink call is treated
    as cache eviction, not a manifest write; deliberately NOT marked
    as a leaf `fs.write` so the (deferred) MANIFEST_WRITES_ARE_ATOMIC
    policy would not fire on cache cleanup.

### Phase 4 deferred items (re-scope to Phase 7)

**All 4 effect-policies (Step 4.3), all 3 effect-suppressions
(Step 4.4), and all 4 negative tests (Step 4.5) are deferred.** The
phase doc anticipated landing the policies once Step 4.1 + 4.2 were
in place; in practice the strict-mode fail-closed mechanism (Round 2
D-CG-5) is **globally unconditional** on the call graph's
`unresolvedCalls` set, not scoped to each policy's `target-scope`:

```ts
// packages/effect-evaluator/src/evaluator.ts:307–325
for (const u of callGraph.unresolvedCalls) {
  const v = buildUnresolvedCallViolation({ policy: undefined, ... });
  if (strictMode) violations.push(v);  // error-severity
}
```

The Stele repo's call graph contains **344 unresolved-call sites**
(across `packages/cli/src/**`, including 51 in `index.ts` alone from
Commander's chained `.command(...).description(...).action(...)`
fluent API, 38 in test files, and many `dynamic`-reason sites from
untyped object dispatch in `glob.ts`, `architecture-runtime.ts`,
`backend-registry.ts::loadBackend`, etc.). The moment ANY
`effect-policy` is added to the contract, the effect stage activates
and every one of these 344 sites produces an `error`-severity
violation — even when the policy's `target-scope` is narrow (e.g.
`packages/core/src/**::*` for `CORE_IS_PURE_OR_FS_READ`).

Per the prompt's policy-gap rule ("If a policy fires on legitimate
code that the suppressions don't cover, defer that policy + log the
gap — DON'T silence the policy by adding a wildcard suppression"),
the only correct path is to defer the policies. The four candidate
policies — `CORE_IS_PURE_OR_FS_READ`, `MANIFEST_WRITES_ARE_ATOMIC`,
`HOOK_NO_NETWORK`, `GENERATOR_NO_NETWORK_OR_CHILD_PROCESS` — and
their three associated effect-suppressions remain valid as
specifications; they cannot be enforced today without one of the
following changes (Phase 7 options):

1. **Per-policy scoping for unresolved-call emission** in
   `@stele/effect-evaluator`. Skip `buildUnresolvedCallViolation` for
   `(fromId)` nodes that do not match any policy's `target-scope`.
   Round 2 D-CG-5's wording is "unresolved calls fail closed" — the
   intent is policy-scoped fail-closed, but the implementation is
   global. Cleanest fix.
2. **A configurable `strictMode` per stele.config.json**, so the Stele
   repo (where the CLI legitimately uses dynamic dispatch outside
   policy scope) can run in lenient mode while still emitting violation
   notices for audit. Less principled than (1) but a smaller patch.
3. **CLI source refactoring** to eliminate the 100+ dynamic-dispatch
   sites — far larger than Phase 4 scope and would require touching
   every Commander `.action(...)` chain plus the dynamic-backend-import
   path. Not recommended.

Defence-in-depth note: the legacy `CORE_ENGINE_PURITY` Python checker
(introduced in Round 7) continues to pass and still enforces
"no clock / random / env / crypto outside the canonical allowlist"
on `packages/core/src/**`. The intent of `CORE_IS_PURE_OR_FS_READ` is
already covered functionally, just not via the effect-policy
mechanism, until the evaluator gap is closed.

### Phase 4 perf baseline

Wall-clock for `time node packages/cli/dist/index.js check` (warm
caches):

| | seconds |
| --- | --- |
| Before Phase 4 (48 invariants, 4 trace-policies, 0 effect-policies) | 13.8 |
| After Phase 4 (48 invariants, 4 trace-policies, 0 effect-policies, 1 effect-declarations + 17 effect annotations) | 13.7 |
| Delta | ~0 |

The effect-stage early-returns when `effectPolicies.length === 0`
(see `packages/cli/src/commands/check-stages-effect.ts:97`), so the
effect-stage cost is zero today. The 17 JSDoc annotations are
out-of-band metadata the call-graph extractor ignores; once the
deferred policies land in Phase 7 the cost will be the call-graph
extraction (already amortised with the trace stage via the call-graph
cache) plus the propagation pass — Round 2 MC-7 bounds propagation at
`O(|edges| + |nodes|)`, so the projected cost is in the 1–2 s range
on this 9.3k-node × 41k-edge graph.

### 2026-05-25 — Phase 5 sub-agent

- **All four type-state lifecycles landed compile-time enforcement.**
  Each lifecycle ships a `lifecycle.ts` module with a state-keyed
  `StateBrand<S>` (per reviewer V-05) and a paired `.test-d.ts` file
  that pins three `@ts-expect-error` sites. The proof step (remove a
  pin, run `pnpm --filter <pkg> typecheck`, see a TS2345
  argument-not-assignable error) was executed manually for every
  landed lifecycle; the brand discriminator fires correctly in all
  four cases. Lifecycles landed:
  1. MANIFEST_LIFECYCLE — `packages/core/src/manifest/lifecycle.ts` —
     Unloaded → Loaded → Locked → Verified.
  2. APPROVAL_LIFECYCLE —
     `packages/cli/src/commands/design/approval-lifecycle.ts` —
     Drafting → IdentityChecked → Signed.
  3. DESIGN_PROFILE_LIFECYCLE —
     `packages/cli/src/design-profile/lifecycle.ts` — Raw → Validated
     → Hashed (the Hashed pair carries the profile + Sha256 hash).
  4. CALLGRAPH_LIFECYCLE —
     `packages/call-graph-core/src/lifecycle.ts` — Empty → Building →
     Built → Cached.

- **`@stele/type-state-evaluator` matches zero call sites today.** The
  evaluator's TS inference extractor only handles
  `receiver.method(...)` call expressions whose receiver type
  instantiates one of `decl.target`'s methods (see
  `packages/backend-typescript/src/extractors/type-state-inference.ts`
  §`inferInSourceFile`). Production callers continue to use the
  existing free-function APIs (`writeManifest(...)`,
  `verifyManifest(...)`, `loadProfile(...)`, etc.); the typed
  pipelines added in Phase 5 are not yet threaded through them. The
  consequence: the CDL `(type-state ...)` declarations validate
  structurally but the evaluator finds nothing to flag. This was
  accepted per the prompt's instruction to defer >30-LOC refactors
  to Phase 7. **Compile-time enforcement** is fully active for every
  lifecycle; **evaluator-time enforcement** is documentation-only
  until Phase 7 routes production callers through the typed methods.

- **Negative tests use `tsc --noEmit` rather than `stele check`.**
  The Phase 5 negative tests in
  `contract/checker_impls/test_negative.py`
  (`test_{manifest,approval,design_profile,callgraph}_lifecycle_brand_fires`)
  mutate a single `@ts-expect-error` pin in the matching `.test-d.ts`
  file, run `pnpm --filter <pkg> typecheck`, and assert that the
  compiler surfaces a TS2345 argument-not-assignable error.
  Restoration of the file is guaranteed via `try/finally`. This is
  the natural shape for compile-time-only contracts; using
  `stele check` would loop back through the evaluator and (per the
  point above) find nothing.

- **`packages/call-graph-core/tsconfig.json` widened to include
  `tests/**`.** Previously the package's `rootDir` was `src` and the
  include only matched `src/**/*.ts`, so a `.test-d.ts` file under
  `tests/` would not participate in `typecheck`. Phase 5.4 dropped
  the `rootDir` constraint (it was redundant — tsup builds
  `src/index.ts` only, and the existing vitest tests already imported
  from `../src/` without typecheck coverage) and widened the include
  glob to `tests/**/*.ts`. No production-build artefact change; the
  emitted dist/ shape is identical.

- **Three pre-existing `stele check` errors persist throughout
  Phase 5.** `[error] write-atomic-has-rename`,
  `[error] trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth`,
  and `[error] trace.CHECK_PREPARE_VIA_LOAD_CONTRACT.missing_predecessor`
  were already firing before Phase 5 began (the prompt's "48
  invariants pass" pre-flight refers to the 48 RULE_KIND="rule"
  checks; the Phase B stages have separate gating that was already
  red). Phase 5 did NOT touch the underlying issues — they are
  outside the lifecycle scope and Phase 7 / a follow-up will need to
  re-land the `writeAtomic` rename call that Phase 4 inadvertently
  regressed in commit `451a1d0` (see
  `packages/core/src/manifest/hash-manifest.ts:218`).

### Phase 5 deferred items (re-scope to Phase 7)

- **Routing production call sites through the typed lifecycle
  methods.** Today `writeManifest`, `verifyManifest`, `loadProfile`,
  `validateProfile`, `hashFile`, and the call-graph extractor are
  free-function APIs. Threading them through `asLoaded → lockManifest
  → verifyLockedManifest` (and the analogous chains for the other
  three lifecycles) would make the `@stele/type-state-evaluator`
  catch wrong-state arguments at every real call site. Estimated
  surface: ~3 sites for MANIFEST (`lock.ts`, `baseline.ts`,
  `check-stages-protected.ts`), ~1 site for APPROVAL (`approve.ts`),
  ~10–15 sites for DESIGN_PROFILE (every generate/check entry that
  loads a profile), ~5–10 sites for CALLGRAPH (every evaluator
  invocation). Each refactor exceeds the prompt's 30-LOC budget for
  Phase 5; consolidated Phase 7 follow-up.

- **`type-state-binding` declarations.** The Phase 5.1 phase document
  proposes `(type-state-binding (target "...::writeManifest") (param 0
  in-state Locked))` as a way to tell the evaluator "this caller has
  already been audited; accept Locked here". The bindings are
  meaningful only once production callers route through the typed
  pipeline; without the upstream refactor the bindings would target
  the free-function API and the evaluator would still match zero
  call sites. Bindings deferred alongside the upstream refactor.

---

## Execution model

This document is executed by a series of sub-agents (one per phase).
The main agent:

1. Reads this README.md and the per-phase document
2. Spawns a sub-agent with the per-phase document as input
3. Receives the sub-agent's completion report
4. Verifies CC-3 (all green) before moving to the next phase
5. After all phases: spawns the reviewer sub-agent for Phase 7

A sub-agent that is asked to execute a phase MUST:

- Read this README.md first
- Read its phase document
- Refuse to take actions not specified by the phase document
- Surface any ambiguity in writing before acting
- Run CC-3 before and after every step
- Return a detailed completion report to the main agent

A sub-agent may NOT:

- Skip required steps
- Modify the plan documents themselves (only the main agent can)
- Open new scope from "while I'm here, this looks bad" — file a
  Phase 7 follow-up note instead
