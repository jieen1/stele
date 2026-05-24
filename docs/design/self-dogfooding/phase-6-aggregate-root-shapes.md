# Phase 6 — Aggregate-Root class-shape Strengthening

**Goal:** The 10 `core-node` aggregate roots in `ddd-typedriven.stele`
already enforce metric boundaries (sloc / public-method-count /
max-cyclomatic). Add `class-shape` declarations alongside each so
their structural shape (must-have methods + must-have fields +
must-extend) is also locked.

**Why:** A complexity-bounded aggregate root with no structural lock
can still be silently rewritten as long as the metric thresholds
hold. Adding `class-shape` makes the aggregate's identity stable.

**Estimated effort:** 1.5 working days.

**Out of scope:**
- Adding new aggregate roots
- Changing existing metric boundaries

## Required dependencies

- **Phase 2** (class-shape evaluator must work — already verified in
  Round 14 P1)
- The 10 existing core-node declarations in `ddd-typedriven.stele`

## The 10 class-shape rules

Each aggregate root in `contract/design/profile.yaml` gains a paired
`class-shape` declaration. The design generator emits both `core-node`
and `class-shape` for each.

### Step 6.1 — Update the design profile schema

**File:** `contract/design/profile.yaml`

For each aggregate root, add a `required_methods` and
`required_fields` block:

```yaml
aggregate_roots:
  - id: operator-registry
    class: OperatorRegistry
    target: "packages/core/src/registry/operators.ts::OperatorRegistry"
    required_methods:
      - register
      - lookup
      - all
    required_fields:
      - operators
    metrics:
      sloc: { ideal: 400, max: 800 }
      public-method-count: { ideal: 8, max: 20 }
      max-cyclomatic: { ideal: 10, max: 25 }
```

Apply to all 10 aggregates:

| Aggregate | Required methods | Required fields |
|---|---|---|
| operator-registry | `register`, `lookup`, `all` | `operators` |
| invariant-validator | `validate`, `buildContext` | – |
| contract-loader | `load`, `parseFile` | – |
| manifest-engine | `write`, `verify` | `protected_files`, `version` |
| cli-check-orchestrator | `runCheck` | – |
| cli-code-shape-evaluator | `evaluateCodeShapes` | – |
| cli-design-diff-engine | `computeDesignDiff` | – |
| cli-cli-program-factory | `createProgram`, `runCli` | – |
| cli-design-profile-validator | `validateProfile` | – |
| architecture-architecture-evaluator | `evaluateArchitecture` | – |

### Step 6.2 — Update the design generator

**File:** `packages/cli/src/design-generator/render/aggregates.ts`
(find / create)

Emit a `(class-shape …)` for every aggregate that has either
`required_methods` or `required_fields`. Existing `core-node`
emission unchanged.

### Step 6.3 — Approve + regenerate

```
STELE_APPROVED_BY="<your-email>" node packages/cli/dist/index.js design approve \
  --reason "Phase 6 self-dogfooding: aggregate-root class-shape"

STELE_APPROVED_BY="<your-email>" node packages/cli/dist/index.js design generate
```

`contract/generated/ddd-typedriven.stele` now has 10 new `class-shape`
entries.

### Step 6.4 — Address violations

Some aggregates may not actually have the listed methods (e.g. an
old name). Either:

- Update the source to match
- Or update `profile.yaml` to match the real method names

Don't add "alias" methods to satisfy the contract.

### Step 6.5 — Add 10 negative tests

Each test removes one method/field from one aggregate temporarily and
asserts the contract fails.

### Step 6.6 — Re-lock + verify

```
pnpm build
node packages/cli/dist/index.js generate --force
node packages/cli/dist/index.js lock --reason "Phase 6: 10 aggregate-root class-shape contracts"
node packages/cli/dist/index.js check     # ~84 invariants total
```

## Acceptance criteria

- [ ] 10 new `class-shape` declarations in generated `ddd-typedriven.stele`
- [ ] All 10 pass against the live source
- [ ] 10 paired negative tests
- [ ] `stele check` exit 0

## Dependencies

- Phase 2 (class-shape evaluator)
- Existing `core-node` declarations

## Rollback strategy

The design generator change can be reverted; the new fields in
profile.yaml don't affect anything if the generator doesn't read them.

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding/README.md and
docs/design/self-dogfooding/phase-6-aggregate-root-shapes.md.

Confirm Phase 2 is complete.

Execute steps 6.1 → 6.6 in order. After 6.2, run the generator and
inspect the output before approving — a wrong template here cascades
to 10 broken contracts.
```
