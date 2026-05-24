# Phase 2 — Code-Shape Rules for Stele's Own Source

**Goal:** Write 12 `boundary` / `class-shape` / `function-shape` /
`type-policy` / `file-policy` contracts that the existing
`@stele/code-shape` evaluator runs against THIS repo's source.

**Why:** All 5 code-shape primitives ship as supported forms; the
evaluator runs on every `stele check`. The repo currently has **zero**
code-shape contracts. The Round 14 P1 work added TypeScript support
to the evaluator — this Phase actually uses it.

**Estimated effort:** 3 working days.

**Out of scope:**
- Adding new code-shape primitives
- Code-shape rules for `examples/`, `fixtures/`, `tests/` (only
  production source under `packages/*/src` and `contract/checker_impls/`)

## Scope summary

Write 12 contracts. Each contract targets a real structural rule
that's currently enforced by either a Python checker, convention, or
nothing at all. Where a Python checker overlaps, the Python checker
becomes the secondary (defence-in-depth) layer and the code-shape
contract is the primary mechanical lock.

## The 12 contracts

### 2.1 — `boundary` × 2

#### `CORE_NO_FS_WRITE_FROM_NON_MANIFEST`

```lisp
(boundary core-no-fs-write-from-non-manifest
  (lang typescript)
  (target "packages/core/src/**/*.ts")
  (deny-import "node:fs/promises::writeFile")
  (deny-import "node:fs/promises::appendFile")
  (deny-import "node:fs/promises::rm")
  (deny-import "node:fs/promises::unlink")
  (allow-target "packages/core/src/manifest/**")
  (allow-target "packages/core/src/generator/file-walk.ts"))
```

**Why:** `@stele/core` must be pure outside the manifest write
helpers. Anything else importing `writeFile` is a defect.

#### `CLI_COMMANDS_NO_DIRECT_FS_WRITE`

```lisp
(boundary cli-commands-no-direct-fs-write
  (lang typescript)
  (target "packages/cli/src/commands/**/*.ts")
  (deny-call "writeFileSync")
  (deny-call "appendFileSync")
  (allow-target "packages/cli/src/commands/init.ts")
  (allow-target "packages/cli/src/commands/design/init.ts")
  (allow-target "packages/cli/src/commands/design/approve.ts")
  (allow-target "packages/cli/src/commands/design/propose.ts")
  (allow-target "packages/cli/src/commands/design/generate.ts"))
```

**Why:** CLI command files should route writes through helpers like
`writeAtomic`. Sync writes are red flags except in the listed
bootstrap commands.

### 2.2 — `class-shape` × 4

#### `OPERATOR_REGISTRY_SHAPE`

```lisp
(class-shape operator-registry-shape
  (lang typescript)
  (target "packages/core/src/registry/operators.ts::OperatorRegistry")
  (must-have-method "register")
  (must-have-method "lookup")
  (must-have-method "all"))
```

#### `MANIFEST_ENGINE_SHAPE`

```lisp
(class-shape manifest-engine-shape
  (lang typescript)
  (target "packages/core/src/manifest/manifest.ts::Manifest")
  (must-have-field "version")
  (must-have-field "stele_version")
  (must-have-field "protected_files")
  (must-have-field "contract_hash"))
```

#### `VIOLATION_REPORT_SHAPE`

```lisp
(class-shape violation-report-shape
  (lang typescript)
  (target "packages/core/src/report/types.ts::ViolationReport")
  (must-have-field "tool")
  (must-have-field "command")
  (must-have-field "ok")
  (must-have-field "summary")
  (must-have-field "violations"))
```

#### `CLI_COMMAND_ERROR_SHAPE`

```lisp
(class-shape cli-command-error-shape
  (lang typescript)
  (target "packages/cli/src/errors.ts::CliCommandError")
  (must-extend "Error")
  (must-have-field "exitCode"))
```

### 2.3 — `function-shape` × 3

#### `HOOK_FAIL_CLOSED_V2`

```lisp
(function-shape hook-fail-closed-v2
  (lang typescript)
  (target "packages/claude-code-plugin/scripts/pre-tool-protect.js::main")
  (must-have-call "failClosed")
  (must-have-call "process.exit"))
```

(Note: `lang typescript` works for `.js` ESM too — TS analyzer
handles JS shape adequately for shape checks.)

#### `STOP_VALIDATE_FAIL_CLOSED`

```lisp
(function-shape stop-validate-fail-closed
  (lang typescript)
  (target "packages/claude-code-plugin/scripts/stop-validate.js::main")
  (must-have-call "blockStop"))
```

#### `WRITE_ATOMIC_HAS_RENAME`

```lisp
(function-shape write-atomic-has-rename
  (lang typescript)
  (target "packages/core/src/manifest/hash-manifest.ts::writeAtomic")
  (must-have-call "rename"))
```

**Why:** `writeAtomic` must use `rename` for atomic file replacement;
a refactor that drops `rename` silently breaks the guarantee.

### 2.4 — `type-policy` × 2

#### `NO_ANY_IN_CORE`

```lisp
(type-policy no-any-in-core
  (lang typescript)
  (target "packages/core/src/**/*.ts")
  (deny-type "any"))
```

**Why:** `@stele/core` ships `tsconfig.base.json` with `strict: true`,
so `any` should not appear. This contract enforces it mechanically.

#### `RULE_ID_FIELDS_BRANDED`

```lisp
(type-policy rule-id-fields-branded
  (lang typescript)
  (target "packages/core/src/report/types.ts::Violation")
  (require-type "RuleId"))
```

**Why:** Cross-checks Phase 1 — the `Violation.rule_id` field must be
typed `RuleId` (not `string`).

### 2.5 — `file-policy` × 1

#### `HOOK_SCRIPTS_SHEBANG`

```lisp
(file-policy hook-scripts-shebang
  (lang typescript)
  (target "packages/claude-code-plugin/scripts/*.js")
  (must-contain "#!/usr/bin/env node"))
```

**Why:** Every hook script must have a shebang so it can be invoked
directly by Claude Code.

## Implementation steps

### Step 2.1 — Write the 12 declarations in `contract/main.stele`

Put them in a new section "Code-shape contracts (Phase 2
self-dogfooding)" after the existing `(invariant …)` block.

### Step 2.2 — Run `stele check` and observe violations

Some contracts will fail because existing source isn't yet conformant.
For each failing contract:

- If the source is correct and the contract is wrong: fix the contract
- If the contract is right but source is wrong: fix the source
- If the contract requires a refactor that exceeds Phase 2 scope:
  remove the contract from this Phase, file as Phase 7 follow-up

### Step 2.3 — Anticipated source changes

| Contract | Likely violation | Fix |
|---|---|---|
| `NO_ANY_IN_CORE` | Some `any` in tests-adjacent files; possibly `unknown` in error handling | Replace with `unknown` + narrowing |
| `CORE_NO_FS_WRITE_FROM_NON_MANIFEST` | None expected (CORE_ENGINE_PURITY already enforces this) | – |
| `CLI_COMMANDS_NO_DIRECT_FS_WRITE` | A few sync writes in design/init.ts already allow-listed | – |
| `MANIFEST_ENGINE_SHAPE` | Manifest fields are correct, check passes | – |
| `WRITE_ATOMIC_HAS_RENAME` | Should pass — rename IS used | – |
| `HOOK_FAIL_CLOSED_V2` | Should pass — Round 8 K-02 already verified | – |

### Step 2.4 — Add 12 negative tests

Each negative test mutates one structural property (e.g., remove
the `register` method from OperatorRegistry temporarily) and asserts
the corresponding contract fails.

### Step 2.5 — Re-lock + verify

```
pnpm build
node packages/cli/dist/index.js generate --force
node packages/cli/dist/index.js lock --reason "Phase 2: 12 code-shape contracts"
node packages/cli/dist/index.js check     # exit 0, ~60 invariants total
```

## Acceptance criteria

- [ ] 12 code-shape declarations in `contract/main.stele`
- [ ] All 12 pass on the live repo
- [ ] 12 paired negative tests in `test_negative.py`
- [ ] `stele check` reports the new contracts in `stele list`
- [ ] `pnpm test` green across all packages

## Dependencies

- Phase 1 (RULE_ID_FIELDS_BRANDED depends on the `RuleId` branded type
  being adopted on the `Violation` type)

## Rollback strategy

Per-contract revert: each contract is added with its own checker (if
any) so reverting a single contract is one Edit + one regenerate +
one lock.

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding/README.md and
docs/design/self-dogfooding/phase-2-code-shape.md.

Land contracts in the order 2.1, 2.2, 2.3, 2.4, 2.5. For each
contract:
  1. Add the CDL declaration
  2. Run `node packages/cli/dist/index.js check`
  3. If it fails, address the violation per Step 2.3 guidance
  4. Add the negative test
  5. Re-lock

Don't add ALL 12 declarations at once — that makes failures hard to
attribute.
```
