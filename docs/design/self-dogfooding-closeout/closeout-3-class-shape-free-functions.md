# Closeout 3 — Class-shape evaluator first-class free-function support

**Goal:** Extend the class-shape evaluator so a `(class-shape ...)`
declaration whose `target` points at a free function (module-level
or factory-returned object) binds and enforces required-method /
required-field constraints against the function's exports / returned
shape. Then populate all 9 deferred aggregate class-shapes.

**Why:** Round 16 confirmed the class-shape evaluator only binds to
TypeScript `class` declarations. Stele's own DDD profile uses
"anemic with guarded invariants" → 9 of 10 aggregates are
implemented as free functions (`runCheck`, `loadContract`,
`evaluateArchitecture`, etc.). The original deferral decision was
correct given the evaluator's limits at the time, but it left 9
aggregate identities silently unenforced.

After this closeout:

- The class-shape evaluator supports two target kinds: real `class`
  declarations (existing) **and** free-function / factory targets
  (new).
- For free-function targets, the evaluator inspects:
  - Required-method semantics: the function's same-module sibling
    exports OR the shape of the object the function returns.
  - Required-field semantics: same — sibling const exports for the
    module-level case, returned-object properties for the factory
    case.
- All 9 deferred aggregates have populated `required_methods` and
  (where applicable) `required_fields`.
- Each aggregate gets 2 paired negative tests (one method, one
  field — fallback to two methods if no fields are required).

**Out of scope:**
- New aggregates beyond the existing 10
- Changing existing class-shape binding for `class`-declared targets

## Two parts: 3a (evaluator) then 3b (population)

Closeout 3 is large; the sub-agent dispatch is split.

### 3a — Evaluator extension

**File:** `packages/cli/src/code-shape/evaluate.ts` (the binding /
violation path that emits "Target class … was not found", per
Round 16's investigation at line 396).

#### Steps 3a

##### 3a.1 — Read + design

Read the current class-shape evaluator. Locate:

- The target resolver (TypeScript symbol → AST node).
- The required-method check.
- The required-field check.
- The "not found" violation emission.

Design the free-function detection logic:

- Target string is `path::name` (existing).
- If the symbol at `name` resolves to a `class` declaration → existing path.
- If the symbol resolves to a `FunctionDeclaration` /
  `VariableDeclaration` whose initializer is a function expression →
  **new path: "module function" mode**. The required-method and
  required-field lookup uses **explicit aggregate-member enumeration**,
  NOT "all siblings":
  - The class-shape CDL form gains a new optional field
    `(aggregate-members "name1" "name2" ...)` listing the exact
    sibling exports that belong to this aggregate. Required-method
    / required-field checks only look at members in this list.
  - Without `aggregate-members`, the contract resolution falls back
    to "the target itself only" — a single-function aggregate whose
    methods/fields must be the function's own static properties.
    Free-function aggregates without explicit `aggregate-members`
    cannot declare `required_methods` other than `[<target-name>]`;
    declaring others is a validation error.
  - This prevents two aggregates targeting the same module from
    cross-binding on each other's siblings (M6 fix).
- If the symbol resolves to a function whose return type is a
  literal object type (`function makeFoo(): { a(): void; b(): void }`)
  → **new path: "factory" mode**.
  - Required-method targets check the return type's properties.
  - Required-field targets check the return type's properties.
  - `aggregate-members` is not used in factory mode (the return type
    IS the enumeration).
- Otherwise → unchanged "not found" emission.

The `(aggregate-members …)` form must also be plumbed through the
design generator: `AggregateRoot` gains an optional
`aggregate_members?: string[]` field; the renderer emits
`(aggregate-members "x" "y")` when populated. Validate at design-
profile load time that every `required_methods` / `required_fields`
entry appears in `aggregate_members` (when the target is a free
function — class targets keep their existing semantics).

##### 3a.2 — Implement the two new paths

Inside the existing evaluator, dispatch on AST kind. Module-function
mode and factory mode share the required-method / required-field
predicates but differ in where they look up the property set.

##### 3a.3 — Unit tests in `packages/cli/tests/code-shape/`

Add (at minimum):

1. **Class target — existing path still works.** (Regression guard.)
2. **Module-function target — required method present.** Free-function
   `runCheck` declared in `check.ts` with sibling exports
   `prepareCheckContextWithContract`, `runCheckImpl`, etc.; class-shape
   declares `(must-have-method "runCheck")` → passes.
3. **Module-function target — required method MISSING.** Same setup
   but the class-shape declares `(must-have-method "nonexistent")`
   → emits the class-shape violation.
4. **Factory target — required method present in returned shape.**
   `function makeRegistry(): { add(): void; get(): unknown }`;
   class-shape requires `add` and `get` → passes.
5. **Factory target — required method missing in returned shape.** →
   emits violation.
6. **Module-function target — required field present** (sibling
   const export).
7. **Module-function target — required field missing.**
8. **Target resolves to neither class, function, nor factory** →
   emits the existing "not found" violation (regression guard).

All tests assert; no return-True patterns.

##### 3a.4 — Wire AggregateRoot type if needed

`packages/cli/src/design-generator/types.ts::AggregateRoot` already
gained `required_methods` / `required_fields` in commit `07967b9`.
Verify those carry through to the generated class-shape AST. If the
generator's `renderAggregateClassShape` previously short-circuited
on `class === undefined` or similar, remove the short-circuit — every
aggregate now produces a class-shape.

##### 3a.5 — Re-lock + CC-3

Verify the operator-registry class-shape (already landed) still
binds and tests still pass. The 9 not-yet-populated aggregates do
not produce class-shapes yet (their `required_methods` arrays are
empty); generator falls through to core-node-only emission for them
until 3b.

CC-3 must be green before 3b dispatch.

### 3b — Populate 9 aggregates

#### Steps 3b

##### 3b.1 — Inspect each aggregate's live source

For each of the 9 aggregates listed in
`docs/internal/self-dogfooding-2026-Q2.md` § "Phase 6 deferrals (9)",
open the target file and identify:

- The exported function or factory that constitutes the aggregate.
- The 1–3 methods/exports that constitute the aggregate's identity
  (the ones a sensible refactor would NEVER rename without breaking
  the aggregate concept).
- The 0–2 fields/state items the aggregate owns.

Cross-check against the live class names — the original phase doc's
suggestions (`runCheck`, `loadContract`, etc.) may not match the
real exports verbatim.

##### 3b.2 — Update `contract/design/profile.yaml`

For each aggregate: populate `required_methods` and (where
applicable) `required_fields` with the real names found in 3b.1.

For aggregates where the target was previously an interface (similar
to the operator-registry case), switch to the concrete implementation
or to the free-function path now supported.

##### 3b.3 — Design propose + approve

```
node packages/cli/dist/index.js design propose ...
node packages/cli/dist/index.js design approve --reason "Closeout 3b: populate 9 aggregate class-shapes"
node packages/cli/dist/index.js design generate
```

##### 3b.4 — 9 × 2 paired negative tests + verify operator-registry's pair

Per CC-13, each aggregate gets 2 paired negative tests of DIFFERENT
shape (not two removals):

- **Test A: target removal** — remove one `required_method` from
  source (delete the entire method body / export); assert
  `core-<aggregate>-aggregate-shape` rule fires.
- **Test B: structural mutation** — change the method's signature
  to violate `required_fields` (if any) OR rename one
  `aggregate_members` entry so the contract sees a missing sibling;
  assert the contract fires for a structurally different reason
  than Test A.

If a sub-agent finds an aggregate where no meaningful Test B exists,
STOP — the contract is under-specified.

That is 18 new negative tests for the 9 not-yet-populated
aggregates. **Additionally:** verify the already-landed
`operator-registry` aggregate has 2 tests of different shape. Today
it has:
- `test_operator_registry_shape_catches_missing_method` (Test A
  shape — removes `register`)
- `test_operator_registry_shape_catches_missing_field` (Test B
  shape — removes `#operators` field)
Confirm these are present in `contract/checker_impls/test_negative.py`
and use `assert`. If only one exists, add the second. Final count
across all 10 aggregates: 20 negative tests (2 × 10).

All tests use `_mutate_then_check` with `assert`, not `return`.

##### 3b.5 — Re-lock + CC-3

```
pnpm build && pnpm typecheck
node packages/cli/dist/index.js lock
node packages/cli/dist/index.js check
.venv/bin/pytest tests/contract -q
.venv/bin/pytest contract/checker_impls/test_negative.py -q
```

Negative test count should grow by 18 (from current 88 to ~106; some
arithmetic depends on closeouts 1+2's additions which precede this).

##### 3b.6 — Update predecessor decision-log

Append `RESOLVED in commit <closeout-3b SHA>` to:

- README.md "9 aggregate-root class-shapes" line in the Phase 6
  close-out entry
- Q2 summary doc § "Phase 6 deferrals (9)"

## Acceptance criteria

- [ ] Class-shape evaluator supports class, module-function, and
      factory targets
- [ ] 8+ new unit tests in `packages/cli/tests/code-shape/`
- [ ] All 10 aggregate class-shapes are populated and bound
- [ ] Each aggregate has 2 paired negative tests (18 new negative
      tests total)
- [ ] `stele check` exit 0
- [ ] No `(class-shape ...)` declaration in `ddd-typedriven.stele`
      reports "Target class ... was not found"
- [ ] Predecessor decision-log appended with RESOLVED lines

## Sub-agent execution prompts

### 3a prompt

```
Read README.md + closeout-3-class-shape-free-functions.md.

Execute steps 3a.1 → 3a.5 ONLY. Stop after 3a is green. Do NOT
touch profile.yaml (that is 3b's job).

Forbidden:
- Adding any "skip free-function targets" flag
- Suppressing "Target not found" violations to make existing tests
  green — fix the evaluator until they actually pass
- Hard-coding the 10 aggregate names into the evaluator

Land in 2 commits: evaluator + tests, then a small commit that
removes any short-circuit in the design generator.

DO NOT push.
```

### 3b prompt

```
Read README.md + closeout-3-class-shape-free-functions.md.

Step 3a is already complete. Execute steps 3b.1 → 3b.6.

For each of the 9 aggregates, read the live source FIRST. Do NOT
take the original phase-6 doc's method names on faith — they were
informed guesses.

Forbidden:
- Setting required_methods to [] to "defer" an aggregate
- Renaming a real exported function so it matches the phase doc
  (CC-12 source edit to satisfy a contract)
- Skipping a negative test for any aggregate

Land in 3-4 commits (3 aggregates per commit) so each batch is
reviewable.

DO NOT push.
```
