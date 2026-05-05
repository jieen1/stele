# Stele v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Stele release that can be installed into a real Python application and enforce contract rules during local development, AI-assisted edits, and CI.

**Architecture:** Use a pnpm TypeScript monorepo with four packages: `@stele/core`, `@stele/backend-python`, `@stele/cli`, and `@stele/claude-code-plugin`. The core owns AST, parsing, validation, normalization, manifests, and generation coordination; Python backend owns pytest translation; CLI is the stable user/CI interface; the plugin shells out to the global `stele` CLI.

**Tech Stack:** Node.js 20+, TypeScript, pnpm workspaces, Vitest, tsup, Commander, pytest-generated Python files, Claude Code plugin files.

---

## Source Context

The workspace currently contains only `Stele-项目设计文档.md`; there is no git repository and no implementation. The plan therefore starts with repository scaffolding and keeps all implementation choices traceable to the design document.

## Recommended Scope Decisions

- v0.1 target is a production-usable Python + pytest contract tool for real application repositories. It must be installable, configurable, enforce protected paths, generate deterministic tests, and fail CI on contract drift or tampering.
- Use `pnpm workspaces` rather than turborepo for the first release. It is simpler and enough for four packages.
- Use a single user-provided pytest fixture named `stele_context`. Generated tests read symbols from this fixture, for example `stele_context["account"]` and `stele_context["positions"]`.
- Implement Python path access with `pathMode: "auto"` by default: dictionary key, object attribute, then hyphen-to-underscore object attribute. This resolves the open `path` question without adding schema syntax to CDL v0.1.
- Implement a pragmatic static type checker: literals and operator returns are typed; `path` returns `Unknown` until schema support exists. `Unknown` can satisfy `Number`, `String`, or `Boolean` slots, but arity and known literal mismatches still fail.
- Support temporal operators in the registry and Python runtime through fixture conventions: `state-before`, `state-after`, `modified`, `before`, `after`, and `within` read from reserved keys under `stele_context`. Complex event modeling remains a v0.5 design topic.
- Make manifests deterministic. `generated_at` can be written by `stele lock`, but it must not participate in `contract_hash`, and `stele check` must compare regenerated content in memory rather than rewriting files.
- v0.1 plugin assumes the CLI is installed globally as `stele`, matching the design document.
- Keep internal sample projects strictly as regression fixtures for Stele itself. They are not the product goal and must not replace real-application integration acceptance.

## File Structure

- Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `README.md`, `LICENSE`.
- Create `packages/core/src/**` for lexer, parser, AST, validation, registry, normalization, manifest, generation coordination, and public API.
- Create `packages/backend-python/src/**` for pytest translation and the generated Python runtime helper.
- Create `packages/cli/src/**` for config loading and commands.
- Create `packages/claude-code-plugin/**` for plugin metadata, hooks, scripts, commands, agent, and skill.
- Create `fixtures/python-app/**` as an internal regression fixture for CLI/backend behavior.
- Create `docs/cdl-spec.md`, `docs/plugin-guide.md`, `docs/app-integration-guide.md`, and keep the existing Chinese design document as the original blueprint.

---

### Task 1: Repository Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `packages/core/package.json`
- Create: `packages/backend-python/package.json`
- Create: `packages/cli/package.json`
- Create: `packages/claude-code-plugin/package.json`

- [ ] **Step 1: Initialize git and package manager metadata**

Run:

```bash
git init
pnpm init
```

Expected: a new git repository and root `package.json`.

- [ ] **Step 2: Replace root `package.json` with workspace config**

Use this content:

```json
{
  "name": "stele-monorepo",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint"
  },
  "devDependencies": {
    "@types/node": "^20.11.30",
    "tsup": "^8.0.2",
    "tsx": "^4.7.1",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 3: Create workspace and TypeScript config**

Use this `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

Use this `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
pnpm install
```

Expected: dependency install succeeds and `pnpm-lock.yaml` is created.

- [ ] **Step 5: Commit scaffold**

Run:

```bash
git add .
git commit -m "chore: scaffold stele monorepo"
```

---

### Task 2: Core AST, Errors, and Operator Registry

**Files:**
- Create: `packages/core/src/ast/types.ts`
- Create: `packages/core/src/errors/SteleError.ts`
- Create: `packages/core/src/registry/operators.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/tests/registry.test.ts`

- [ ] **Step 1: Define AST and type model**

Core types:

```typescript
export type SteleType =
  | "Number"
  | "String"
  | "Boolean"
  | "Path"
  | "Collection"
  | "Predicate"
  | "TimeRange"
  | "Symbol"
  | "Unknown";

export type SourceSpan = {
  file: string;
  line: number;
  column: number;
};

export type AtomNode =
  | { kind: "identifier"; value: string; span: SourceSpan }
  | { kind: "keyword"; value: string; span: SourceSpan }
  | { kind: "string"; value: string; span: SourceSpan }
  | { kind: "number"; value: number; raw: string; span: SourceSpan };

export type ListNode = {
  kind: "list";
  head: string;
  items: AstNode[];
  span: SourceSpan;
};

export type AstNode = AtomNode | ListNode;
```

- [ ] **Step 2: Define `SteleError`**

Error shape:

```typescript
export class SteleError extends Error {
  constructor(
    readonly code: string,
    readonly category: string,
    message: string,
    readonly span?: { file: string; line: number; column: number },
    readonly detail?: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "SteleError";
  }
}
```

- [ ] **Step 3: Register v0.1 operators**

Registry contract:

```typescript
export type OperatorSpec = {
  name: string;
  minArity: number;
  maxArity: number | "variadic";
  argTypes: SteleType[];
  returnType: SteleType;
  description: string;
};
```

Register all operators listed in design section 4.7.2, including `path`, `collection`, comparisons, arithmetic, aggregations, quantifiers, logic, conditionals, temporal operators, and referential helpers.

- [ ] **Step 4: Write registry tests**

Example test:

```typescript
import { describe, expect, it } from "vitest";
import { createCoreOperatorRegistry } from "../src/registry/operators";

it("registers required v0.1 operators", () => {
  const registry = createCoreOperatorRegistry();
  expect(registry.get("eq")?.returnType).toBe("Boolean");
  expect(registry.get("sum")?.returnType).toBe("Number");
  expect(registry.get("forall")?.returnType).toBe("Boolean");
});
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @stele/core test
git add packages/core
git commit -m "feat(core): add ast errors and operator registry"
```

Expected: registry tests pass.

---

### Task 3: Lexer and Parser

**Files:**
- Create: `packages/core/src/lexer/token.ts`
- Create: `packages/core/src/lexer/lexer.ts`
- Create: `packages/core/src/parser/parser.ts`
- Test: `packages/core/tests/lexer.test.ts`
- Test: `packages/core/tests/parser.test.ts`

- [ ] **Step 1: Write failing lexer tests**

Test escaped strings, comments, numbers, identifiers, keywords, and source positions:

```typescript
it("lexes strings numbers keywords comments and parens", () => {
  const tokens = lex("(invariant ACCT_001 (severity critical) ; comment\n)");
  expect(tokens.map((t) => t.type)).toEqual([
    "lparen", "identifier", "identifier", "lparen", "identifier", "identifier", "rparen", "rparen", "eof"
  ]);
});
```

- [ ] **Step 2: Implement lexer**

Rules:
- `;` skips to line end.
- strings only use double quotes.
- supported escapes are `\"`, `\\`, `\n`, `\t`, `\r`.
- invalid characters raise `SteleError("E0001", "Lexical Error", ...)`.

- [ ] **Step 3: Write failing parser tests**

Example:

```typescript
it("parses nested s-expressions with source spans", () => {
  const file = parseFile("(metadata (stele-version \"0.1\"))", "main.stele");
  expect(file.body[0].kind).toBe("list");
  expect(file.body[0].head).toBe("metadata");
});
```

- [ ] **Step 4: Implement parser**

Parser behavior:
- top-level file is a list of expressions.
- list head must be an identifier.
- unmatched parenthesis raises `E0101`.
- atom after EOF raises `E0102`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @stele/core test -- lexer parser
git add packages/core
git commit -m "feat(core): parse cdl s-expressions"
```

Expected: lexer and parser tests pass.

---

### Task 4: Contract Loader and Validation

**Files:**
- Create: `packages/core/src/loader/loadContract.ts`
- Create: `packages/core/src/validator/structure.ts`
- Create: `packages/core/src/validator/references.ts`
- Create: `packages/core/src/validator/types.ts`
- Create: `packages/core/src/validator/uniqueness.ts`
- Test: `packages/core/tests/loader.test.ts`
- Test: `packages/core/tests/validator.test.ts`

- [ ] **Step 1: Write failing loader tests**

Use temp files with `main.stele` importing `modules/account.stele`.

Expected behavior:
- imports are relative to the importing file.
- duplicate import cycles fail with `E0203`.
- all loaded files are included in `contract.files`.

- [ ] **Step 2: Implement `loadContract(rootPath)`**

Public API:

```typescript
export async function loadContract(rootPath: string): Promise<Contract> {
  const files = await loadRecursive(rootPath, new Set(), []);
  return validateContract(buildContract(files));
}
```

- [ ] **Step 3: Write validation tests**

Cover:
- only known top-level declarations are allowed.
- `metadata` appears at most once per file.
- invariant IDs are globally unique.
- `uses-checker` references an existing checker.
- `depends-on` references existing invariant IDs.
- operator arity is enforced.

- [ ] **Step 4: Implement pragmatic type checking**

Rules:
- known literal mismatch fails, for example `(gt "x" 1)`.
- `Unknown` from `path` can satisfy value slots.
- arithmetic operators return `Number`.
- logical operators require boolean or unknown-compatible expressions.
- quantifiers bind the declared symbol inside their predicate.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @stele/core test -- loader validator
git add packages/core
git commit -m "feat(core): load and validate contracts"
```

Expected: loader and validation tests pass.

---

### Task 5: Normalizer and Manifest

**Files:**
- Create: `packages/core/src/normalizer/normalize.ts`
- Create: `packages/core/src/manifest/manifest.ts`
- Test: `packages/core/tests/normalizer.test.ts`
- Test: `packages/core/tests/manifest.test.ts`

- [ ] **Step 1: Write normalizer tests**

Expected:
- canonical field order for invariant: `severity`, `description`, `assert` or `uses-checker`, then optional fields.
- stable whitespace.
- imported files normalize independently.

- [ ] **Step 2: Implement normalizer**

Public function:

```typescript
export function normalizeContract(contract: Contract): string {
  return contract.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => normalizeFile(file))
    .join("\n");
}
```

- [ ] **Step 3: Write manifest tests**

Expected:
- SHA256 changes when protected file content changes.
- `contract_hash` is stable for identical normalized contract content.
- `generated_at` is present but excluded from `contract_hash`.

- [ ] **Step 4: Implement manifest**

Public functions:

```typescript
export async function writeManifest(paths: string[], manifestPath: string, contractHash: string): Promise<void>;
export async function verifyManifest(manifestPath: string): Promise<VerificationResult>;
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @stele/core test -- normalizer manifest
git add packages/core
git commit -m "feat(core): add normalization and manifest verification"
```

---

### Task 6: Python Backend and Runtime Helper

**Files:**
- Create: `packages/backend-python/src/runtime.ts`
- Create: `packages/backend-python/src/translator.ts`
- Create: `packages/backend-python/src/templates/comparison.ts`
- Create: `packages/backend-python/src/templates/arithmetic.ts`
- Create: `packages/backend-python/src/templates/collection.ts`
- Create: `packages/backend-python/src/templates/logic.ts`
- Create: `packages/backend-python/src/templates/temporal.ts`
- Create: `packages/backend-python/src/index.ts`
- Test: `packages/backend-python/tests/translator.test.ts`

- [ ] **Step 1: Define generated pytest runtime**

Generated file path: `tests/contract/_stele_runtime.py`.

Runtime functions:

```python
def stele_get_path(root, parts):
    current = root
    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif hasattr(current, part):
            current = getattr(current, part)
        elif hasattr(current, part.replace("-", "_")):
            current = getattr(current, part.replace("-", "_"))
        else:
            raise KeyError(f"Stele path segment not found: {part}")
    return current
```

- [ ] **Step 2: Write translator snapshot tests**

Input CDL:

```lisp
(invariant ACCT_001
  (severity critical)
  (description "account total equals positions plus cash")
  (assert
    (eq (path account total-value)
        (add (sum (collection positions) (path value))
             (path account cash)))))
```

Expected generated pytest contains:

```python
def test_ACCT_001(stele_context):
    assert stele_get_path(stele_context["account"], ["total-value"]) == (
        stele_sum(stele_context["positions"], ["value"])
        + stele_get_path(stele_context["account"], ["cash"])
    )
```

- [ ] **Step 3: Implement expression translation**

Translation examples:
- `(path account cash)` -> `stele_get_path(stele_context["account"], ["cash"])`
- `(collection positions)` -> `stele_context["positions"]`
- `(sum (collection positions) (path value))` -> `stele_sum(stele_context["positions"], ["value"])`
- `(forall txn (collection transactions) <pred>)` -> `all(<pred> for txn in stele_context["transactions"])`

- [ ] **Step 4: Implement checker invocation**

Generated test pattern:

```python
def test_ACCT_003(stele_context):
    result = stele_call_checker("balance-change-has-transaction", stele_context, {})
    assert result["passed"], result.get("message") or "Checker failed: balance-change-has-transaction"
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @stele/backend-python test
git add packages/backend-python
git commit -m "feat(backend-python): generate pytest contract tests"
```

---

### Task 7: Generation Coordinator and Generated Verification

**Files:**
- Create: `packages/core/src/generator/coordinator.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/generator.test.ts`

- [ ] **Step 1: Define backend interface**

Use one interface in core:

```typescript
export interface LanguageBackend {
  name: string;
  framework: string;
  fileExtension: string;
  version: string;
  generate(contract: Contract, config: GenerationConfig): GeneratedFile[];
}
```

- [ ] **Step 2: Implement deterministic generation**

Rules:
- group output path is stable: `tests/contract/test_<group-id>.py`.
- top-level invariants go to `tests/contract/test_contract.py`.
- runtime helper is generated once at `tests/contract/_stele_runtime.py`.
- generated files are formatted deterministically.

- [ ] **Step 3: Implement `verifyGenerated`**

Behavior:
- generate in memory.
- compare each generated file to disk.
- report missing, extra, and changed generated files.
- do not write during `check`.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm --filter @stele/core test -- generator
git add packages/core
git commit -m "feat(core): coordinate deterministic generation"
```

---

### Task 8: CLI Core Commands

**Files:**
- Create: `packages/cli/src/config/defaults.ts`
- Create: `packages/cli/src/config/loadConfig.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/generate.ts`
- Create: `packages/cli/src/commands/check.ts`
- Create: `packages/cli/src/commands/lock.ts`
- Create: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/cli.test.ts`

- [ ] **Step 1: Add Commander CLI entry**

Command skeleton:

```typescript
program
  .name("stele")
  .description("Contract management for AI-assisted development")
  .version("0.1.0");

program.command("check").action(() => runCheck(process.cwd()));
program.command("generate").option("--force").action((opts) => runGenerate(process.cwd(), opts));
program.command("lock").option("--reason <reason>").action((opts) => runLock(process.cwd(), opts));
program.command("init").option("--language <language>", "target language", "python").action((opts) => runInit(process.cwd(), opts));
```

- [ ] **Step 2: Implement default config**

Use this default:

```json
{
  "version": "0.1",
  "contractDir": "contract",
  "entry": "contract/main.stele",
  "generatedDir": "tests/contract",
  "checkerImplDir": "contract/checker_impls",
  "manifestPath": "contract/.manifest.json",
  "targetLanguage": "python",
  "testFramework": "pytest",
  "pathMode": "auto",
  "protected": [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    "contract/.manifest.json",
    "tests/contract/**/*"
  ]
}
```

- [ ] **Step 3: Implement `stele init`**

Creates:
- `stele.config.json`
- `contract/main.stele`
- `contract/checker_impls/.gitkeep`
- `tests/contract/conftest.py`

`conftest.py` starts with:

```python
import pytest

@pytest.fixture
def stele_context():
    return {}
```

- [ ] **Step 4: Implement `generate`, `check`, and `lock`**

Behavior:
- `generate` writes generated files and manifest.
- `check` validates CDL, verifies generated files, verifies manifest, and exits non-zero on failure.
- `lock` recalculates manifest after approved contract/checker changes.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @stele/cli test
pnpm build
git add packages/cli
git commit -m "feat(cli): add init generate check and lock"
```

---

### Task 9: CLI Authoring and Inspection Commands

**Files:**
- Create: `packages/cli/src/commands/addChecker.ts`
- Create: `packages/cli/src/commands/explain.ts`
- Create: `packages/cli/src/commands/list.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/tests/commands.test.ts`

- [ ] **Step 1: Implement `stele list`**

Output columns:
- ID
- severity
- category
- description
- file path

Filters:

```bash
stele list --severity critical --category data-integrity --tag payment
```

- [ ] **Step 2: Implement `stele explain <id>`**

Output includes:
- full invariant source
- generated test path
- dependencies
- rationale
- checker ID when present

- [ ] **Step 3: Implement `stele add-checker <checker-id>`**

Creates `contract/checker_impls/<checker-id>.py`:

```python
def check(inputs: dict) -> dict:
    return {
        "passed": False,
        "message": "Checker implementation has not been approved yet.",
        "context": inputs,
    }
```

The command prints the exact CDL checker block for the user to add through a controlled contract-change flow.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm --filter @stele/cli test -- commands
git add packages/cli
git commit -m "feat(cli): add contract inspection commands"
```

---

### Task 10: Claude Code Plugin Production Baseline

**Files:**
- Create: `packages/claude-code-plugin/.claude-plugin/plugin.json`
- Create: `packages/claude-code-plugin/hooks/hooks.json`
- Create: `packages/claude-code-plugin/scripts/pre-tool-protect.js`
- Create: `packages/claude-code-plugin/scripts/stop-validate.js`
- Create: `packages/claude-code-plugin/commands/stele-init.md`
- Create: `packages/claude-code-plugin/commands/stele-check.md`
- Create: `packages/claude-code-plugin/commands/stele-add.md`
- Create: `packages/claude-code-plugin/commands/stele-explain.md`
- Create: `packages/claude-code-plugin/agents/contract-author.md`
- Create: `packages/claude-code-plugin/skills/contract-aware-coding/SKILL.md`
- Test: `packages/claude-code-plugin/tests/pre-tool-protect.test.ts`

- [ ] **Step 1: Add plugin metadata**

`plugin.json`:

```json
{
  "name": "stele",
  "version": "0.1.0",
  "description": "Contract management for AI-assisted development",
  "license": "MIT",
  "requirements": {
    "stele-cli": "^0.1.0"
  }
}
```

- [ ] **Step 2: Implement protected-path hook**

Script behavior:
- read hook JSON from stdin.
- read `stele.config.json` from `CLAUDE_PROJECT_DIR`.
- extract write target file path from tool input.
- deny if the path matches `protected`.

Denied output:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "This file is protected by Stele. Use /stele:propose-change or ask the user to approve a contract update."
  }
}
```

- [ ] **Step 3: Implement Stop hook**

Run:

```bash
stele check
```

Expected: non-zero exit blocks completion and surfaces the CLI output.

- [ ] **Step 4: Add slash commands, agent, and skill**

Commands call:
- `/stele:init` -> `stele init`
- `/stele:check` -> `stele check`
- `/stele:add` -> contract authoring instructions
- `/stele:explain` -> `stele explain <id>`

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm --filter @stele/claude-code-plugin test
git add packages/claude-code-plugin
git commit -m "feat(plugin): add claude code protection hooks"
```

---

### Task 11: Production Integration Acceptance

**Files:**
- Create: `fixtures/python-app/stele.config.json`
- Create: `fixtures/python-app/contract/main.stele`
- Create: `fixtures/python-app/contract/modules/account.stele`
- Create: `fixtures/python-app/contract/modules/checkers.stele`
- Create: `fixtures/python-app/contract/checker_impls/balance_change_has_transaction.py`
- Create: `fixtures/python-app/tests/contract/conftest.py`
- Create: `docs/app-integration-guide.md`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Add internal Python application fixture**

Create a realistic Python project fixture with application-like state, not a presentation artifact. Include the three account invariants from the design document and extend the fixture to at least 20 invariants before v0.1 release so parser, validator, generator, checker calls, manifest behavior, and CI behavior all get exercised.

- [ ] **Step 2: Add internal regression fixture data**

`conftest.py` should return passing sample data:

```python
import pytest

@pytest.fixture
def stele_context():
    return {
        "account": {"total-value": 110, "cash": 10, "balance": 10},
        "positions": [{"value": 40}, {"value": 60}],
        "transactions": [{"account-id": "acct_1"}],
        "accounts": ["acct_1"],
    }
```

- [ ] **Step 3: Add CI workflow**

Workflow:

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm build
      - run: cd fixtures/python-app && stele check
```

- [ ] **Step 4: Write real-application integration guide**

`docs/app-integration-guide.md` must document the exact adoption flow for an existing Python application:

```bash
npm install --save-dev stele
stele init --language python --framework pytest
stele generate
pytest tests/contract
stele check
```

It must also state the application-side requirement: the application owns a `stele_context` pytest fixture that returns the real state needed by its contract tests. Stele must not fake application state in generated tests.

The guide must cover:
- where to put `.stele` files,
- how to write or approve checker implementations,
- how to wire `stele check` into CI,
- what files AI agents are blocked from editing,
- how a user performs a controlled contract change with `stele lock`.

- [ ] **Step 5: Verify production integration behavior**

Run:

```bash
pnpm build
cd fixtures/python-app
stele generate
pytest tests/contract
stele check
```

Expected:
- generated pytest tests pass.
- `stele check` exits `0`.
- manually editing `tests/contract/test_account_integrity.py` causes `stele check` to exit `2`.
- manually editing `contract/main.stele` without `stele lock` causes `stele check` to exit `3`.
- installing the packed CLI into a fresh Python repository and running the documented adoption commands succeeds without requiring monorepo internals.

- [ ] **Step 6: Commit integration fixture and CI**

Run:

```bash
git add fixtures docs/app-integration-guide.md .github
git commit -m "test: add production integration acceptance"
```

---

### Task 12: Documentation, Packaging, and Release Candidate

**Files:**
- Create: `docs/cdl-spec.md`
- Create: `docs/plugin-guide.md`
- Create: `docs/app-integration-guide.md`
- Modify: `README.md`
- Modify: package `README.md` files

- [ ] **Step 1: Split the design document into user docs**

Create:
- `docs/cdl-spec.md`: CDL grammar, invariant fields, checker requirements, expression semantics.
- `docs/plugin-guide.md`: install CLI, install plugin, protected paths, legal contract-change flow.
- `docs/app-integration-guide.md`: how to adopt Stele in an existing Python application.
- `README.md`: production-focused quickstart that initializes a Python application, writes a first contract, generates pytest tests, and wires `stele check` into CI.

- [ ] **Step 2: Add package publishing metadata**

Each package needs:
- `name`
- `version`
- `description`
- `type`
- `exports`
- `files`
- `scripts`
- package-specific dependencies

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
cd fixtures/python-app
stele check
pytest tests/contract
```

Expected: all commands pass.

- [ ] **Step 4: Tag release candidate**

Run:

```bash
git status --short
git tag v0.1.0-rc.1
```

Expected: working tree is clean before tagging.

---

## Risk Register

- **CDL type checking can overpromise.** Without schemas, `path` cannot be fully typed. v0.1 should document `Unknown` semantics and fail only on provable errors.
- **Generated pytest tests need user fixtures.** `stele init` must create a clear `stele_context` stub and `stele check` must detect when the fixture is missing by letting pytest fail normally.
- **Manifest determinism is fragile.** Generated file content and protected-file hashes must be byte-stable across platforms. Normalize path separators to POSIX style inside manifest JSON.
- **Claude Code hook schema may shift.** Keep hook parsing defensive and test it with representative hook payloads before publishing.
- **v0.1 scope is broad.** If schedule tightens, keep `init`, `generate`, `check`, `lock`, parser, validator, Python backend, manifest, and PreToolUse hook; defer `dev`, `doc`, reviewer/fixer agents, and non-Python backends.

## Acceptance Checklist

- `stele init` creates a usable project skeleton.
- `stele generate` turns valid CDL into deterministic pytest files.
- `pytest tests/contract` passes in the internal Python application fixture and in a newly initialized external Python application following `docs/app-integration-guide.md`.
- `stele check` detects invalid CDL, stale generated files, and manifest tampering with distinct exit codes.
- Claude Code plugin blocks writes to `contract/**/*.stele`, `contract/checker_impls/**/*`, `contract/.manifest.json`, and `tests/contract/**/*`.
- Internal Python application fixture contains 20+ invariants before public v0.1.
- CI runs `pnpm test`, `pnpm build`, `stele check`, and pytest contract tests.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-stele-v0-1-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh worker per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Approve the scope decisions above first, especially `stele_context`, `pathMode: "auto"`, pragmatic type checking, and global CLI usage for the plugin.
