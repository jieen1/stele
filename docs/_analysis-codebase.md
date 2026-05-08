# Stele Codebase Analysis

> Internal architecture audit. Brutally honest assessment.

---

## A. Architecture Summary

### Package Inventory

| Package | Purpose | Key Files |
|---------|---------|-----------|
| `@stele/core` | CDL parsing, validation, type-checking, manifest I/O, violation reporting, normalizer | 13 subdirectories |
| `@stele/backend-python` | Translates CDL AST to pytest source | `translator.ts`, `runtime.ts`, `templates/` |
| `@stele/cli` | CLI entrypoint, commands (init, generate, lock, check, baseline, propose, etc.) | `commands/`, `config/`, `code-shape/` |
| `@stele/claude-code-plugin` | Claude Code hooks, skills, and sub-agents for contract protection | `scripts/`, `hooks/`, `agents/`, `skills/`, `commands/` |

### Data Flow: CDL Source to Execution

```
CDL Source (.stele files)
  |
  v
[1] Lexer  (lexer/lexer.ts) - Token stream: identifier, keyword, string, number, lparen, rparen, eof
  |
  v
[2] Parser  (parser/parser.ts) - Recursive-descent S-expression parser -> AST (AstNode: list, identifier, keyword, string, number)
  |
  v
[3] Structure (validator/structure.ts) - Semantic pass: classifies top-level declarations into Contract (invariants, groups, scenarios, codeShapes, operators, checkers, imports, metadata)
  |
  v
[4] Validation (validator/types.ts + references.ts + uniqueness.ts) - Three validation passes:
    a) validateUniqueness: duplicate invariant/group/code-shape IDs
    b) validateReferences: invariant depends-on, uses-checker, uses-scenario, group membership
    c) validateTypes: static type inference on assert/when expressions against operator registry
  |
  v
[5] Contract object (Contract type in structure-types.ts)
  |
  v
[6a] Generation coordinator (generator/coordinator.ts) - Coordinates language backend, verifies generated file layout, normalizes paths
  |
  v
[6b] Language Backend (backend-python/translator.ts) - Translates CDL AST nodes to Python expressions, generates test_contract.py + _stele_runtime.py + __init__.py
  |
  v
[7] Manifest Lock (manifest/manifest.ts) - SHA-256 hashes of all protected files, contract hash, versioned JSON
  |
  v
[8] Check (cli/commands/check.ts) - Three-stage verification:
    a) Generated drift: regenerated files vs on-disk
    b) Protected drift: manifest verification + new file detection + contract hash comparison
    c) Code-shape checks: boundary, class-shape, function-shape, type-policy, file-policy evaluation
  |
  v
[9] Violation Report - Merged reports with baseline suppression and diff scoping
```

### Key Interfaces and Extension Points

1. **`LanguageBackend` interface** (`generator/coordinator.ts:24`): The primary extension point for new languages. Defines `generate()` and `supportFiles()` methods.

2. **`OperatorRegistry` interface** (`registry/operators.ts:22`): Defines the S-expression operator vocabulary. `createCoreOperatorRegistry()` ships ~48 operators. Custom operators can be declared in CDL via `(operator ...)` but are only parsed, not integrated into the core type checker.

3. **`Contract` type** (`validator/structure-types.ts:275`): The central IR. Contains flattened arrays of invariants, groups, scenarios, codeShapes, operators, checkers, imports, and metadata.

4. **`OperatorSpec` type** (`registry/operators.ts:11`): Defines operator signatures (name, arity, arg types, return type, description). The type checker validates expressions against this registry.

5. **`Violation` type** (`report/types.ts:38`): The unified violation model with fingerprint, severity, scope_paths, status, and fix metadata.

6. **`SteleError` class** (`errors/SteleError.ts`): Structured error with code, category, message, source span, detail, and hint.

7. **`CodeShapeDeclaration` union** (`structure-types.ts:255`): Boundary, ClassShape, FunctionShape, TypePolicy, FilePolicy. Evaluated by `cli/code-shape/evaluate.ts`.

---

## B. Current Capabilities

### CDL Declaration Types

| Declaration | CDL Syntax | Purpose |
|-------------|------------|---------|
| `invariant` | `(invariant ID (severity ...) (description ...) (assert ...))` | Core contract rules |
| `group` | `(group ID (description ...) (invariant ...))` | Groups related invariants |
| `scenario` | `(scenario ID (sandbox ...) (executor ...) (step ...) (capture-state ...))` | Multi-step test scenarios with sandboxing |
| `boundary` | `(boundary ID (lang python) (target ...) (deny-imports ...) (deny-calls ...) (allow-targets ...))` | Module boundary enforcement |
| `class-shape` | `(class-shape ID (lang python) (target ...) (must-have-fields ...) (must-have-methods ...) (must-extend ...))` | Class structure verification |
| `function-shape` | `(function-shape ID (lang python) (target ...) (must-have-calls ...) (must-have-decorators ...) (must-have-parameters ...))` | Function structure verification |
| `type-policy` | `(type-policy ID (lang python) (target ...) (deny-types ...) (require-types ...))` | Type usage policy |
| `file-policy` | `(file-policy ID (lang python) (target ...) (must-contain ...) (must-end-with ...))` | File content policy |
| `operator` | `(operator name ...)` | Custom operator declaration (parsed only) |
| `checker` | `(checker id ...)` | External checker declaration |
| `metadata` | `(metadata ...)` | Per-file metadata |
| `import` | `(import "path.stele")` | Cross-file imports |

### Operators (from `registry/operators.ts`)

**Path/Value (4):** path, field, collection, value

**Comparison (10):** eq, neq, gt, gte, lt, lte, in, matches, between, approx-eq

**Arithmetic (7):** add, sub, mul, div, neg, abs, (no modulo, no pow)

**Collection Aggregation (8):** sum, count, avg, min, max, distinct, unique, is-empty, has-length

**Collection Quantifiers (4):** where, forall, exists, none

**Logic (7):** and, or, not, implies, iff, when, if

**Temporal (4):** within, after, before, modified, state-before, state-after

**String (3):** contains, starts-with, ends-with

**Null/Existence (2):** not-null, exists-in

**Total: ~49 operators**

### Languages Supported

- **Python/pytest only** (`backend-python` is the sole language backend). The `LanguageBackend` interface is designed for extensibility, but only one implementation exists.

### Integrations

1. **Claude Code plugin**: Pre-tool hook (`scripts/pre-tool-protect.js`) blocks writes to protected paths. Stop hook runs `stele check`. Skills for contract authoring and contract-aware coding.
2. **Git integration**: `--diff-from` scoping, `stele lock` manifest versioning, baseline management
3. **CI-ready**: `stele check` exit codes (2=generation drift, 3=tamper detected)

---

## C. Gaps and Weaknesses

### C.1 Missing Features vs. Mature Contract/Policy Tool

| Gap | Severity | Detail |
|-----|----------|--------|
| **No second language backend** | HIGH | The `LanguageBackend` interface exists but only Python is implemented. No JavaScript/TypeScript, Go, or Rust backend. Limits adoption. |
| **Custom operators not type-checked** | HIGH | Custom operators declared in CDL (`(operator ...)`) are parsed into the Contract IR but are never registered with the `OperatorRegistry` used by `validateTypes()`. The type checker only knows core operators. This means custom operators will fail validation with "Unknown operator" errors (`E0311` in `types.ts:68`). |
| **No test execution** | HIGH | Stele generates pytest files but does not run them. The CLI has no `stele test` or `stele run` command. The user must invoke `python -m pytest` manually. This breaks the self-contained workflow. |
| **No CDL specification document** | MEDIUM | `docs/cdl-spec.md` is referenced in README but not verified. The CDL grammar is implicit in the parser. No formal BNF/EBNF grammar. |
| **Limited type system** | MEDIUM | The type system (`types.ts`) is structural but shallow. It knows `Path`, `Collection`, `Predicate`, `Boolean`, `Number`, `String`, `Symbol`, `Unknown`, `TimeRange`. There is no subtyping, no generic collections, no map/dict type, and no union types. `Path` and `Collection` are not distinguished from each other in the value domain. |
| **No incremental validation** | MEDIUM | Every `loadContract` call re-parses and re-validates all files from scratch. No caching, no incremental checks. |
| **Scenarios are prototype-level** | MEDIUM | Scenario support exists (`structure-scenario.ts`) with sandbox and executor concepts, but the translator only supports `python-import` executor and `transactional` sandbox. The runtime support (`stele_run_scenario`, `stele_merge_contexts`) is embedded in `_stele_runtime.py` but there is no way to write custom scenario executors. |
| **No drift detection for CDL source** | MEDIUM | The manifest records a hash of the normalized contract (`normalizeContract`), but there is no mechanism to detect and report which specific invariants changed between two contract versions. |
| **No contract diff command** | MEDIUM | No `stele diff` or `stele changelog` command. The `maintenance-summary` command exists but is limited to summarizing activity across git refs. |
| **Checker args limited to literals** | MEDIUM | `encodeCheckerArgs` in `translator.ts:757` only handles number, string, boolean, and null literals. It cannot pass path expressions or computed values to checkers. |
| **No `stele context` command** | LOW | The README mentions `npx stele context` but the CLI has no `context` subcommand. It has `agent-context` instead. |
| **No `stele apply` command** | LOW | No command to apply proposals to the main contract file. The `propose` command writes to `contract/proposals/agent-additions.stele` but there is no review/merge workflow. |

### C.2 Codebase Thinness

| Area | Assessment |
|------|-----------|
| **`backend-python/templates/`** | Operator handlers are split into 7 files (`arithmetic.ts`, `collection.ts`, `comparison.ts`, `logic.ts`, `temporal.ts`, `string.ts`). Each is thin (likely <100 lines each). The total translator is ~800 lines for all ~49 operators. This is sustainable but brittle. |
| **`cli/code-shape/`** | The code-shape evaluation (`evaluate.ts`) is in the CLI package, not core. This means code-shapes are CLI-only and cannot be used programmatically. |
| **`baseline/`** | Baseline I/O (`baseline/io.ts`) and types (`baseline/types.ts`) are well-structured. The `filterViolationReport` function in `baseline/types.ts` handles suppression logic. Reasonable. |
| **`normalizer/`** | `normalizeContract` (`normalizer/normalize.ts`) is a deterministic CDL re-renderer. Used for hashing. No incremental normalization. |
| **`report/`** | `report/format.ts` handles human and JSON output. The violation model is well-designed with fingerprinting. |
| **`util/`** | Minimal utilities. `uniqueSortedStrings` and `isMissingFileError` are the main shared functions. No date/time, retry, or concurrency utilities. |

### C.3 Broken or Incomplete User Journeys

1. **Custom operator workflow is broken**: The user declares `(operator my-op ...)` in CDL, but `validateTypes()` uses `createCoreOperatorRegistry()` which only knows built-in operators. The custom operator will never pass type checking. The `OperatorDeclaration` type is parsed but never wired into the registry.

2. **Custom checker arg workflow is limited**: Checkers accept only literal args (line 757-788 in `translator.ts`). You cannot pass `(path account balance)` as a checker arg. This severely limits checker expressiveness.

3. **Scenario execution is incomplete**: The `python-import` executor is the only one, and the runtime serializes scenario definitions as inline Python dicts. There is no way to supply external scenario executors or test fixtures.

4. **Proposal review workflow is missing**: `stele propose invariant --apply` writes to `contract/proposals/agent-additions.stele`. There is no `stele review-proposals` or `stele merge-proposals` command. The user must manually move proposals into main contracts.

5. **`stele check` runs pytest indirectly**: The CLI does not run `pytest` as part of `stele check`. The README says to run `python -m pytest tests/contract` separately. This is a workflow gap -- if Stele is meant to be a self-contained contract enforcement tool, it should run the tests itself.

### C.4 Test Coverage Gaps

From the `test` directory mentioned in recent commits (`operator-backend coverage test`):
- Backend-python has a coverage test (`test/operator-backend-coverage.test.ts`)
- CLI commands appear to have tests (the `cli` package has test infrastructure)
- Core validation likely has tests (implied by `validateUniqueness`, `validateReferences`, `validateTypes`)

**Gaps I cannot verify without seeing test files:**
- Lexer edge cases (malformed input, encoding)
- Parser error recovery
- Type checker coverage for all 49 operators
- Code-shape evaluation edge cases (boundary violations, wildcard patterns)
- Cross-platform path handling (Windows UNC paths, symlinks)
- Baseline suppression logic edge cases
- Manifest version migration

---

## D. Natural Extension Points

### D.1 Easy to Add (existing architecture supports it)

| Extension | Effort | Why |
|-----------|--------|-----|
| **New operators** | Low | Add to `CORE_OPERATOR_SPECS` array + add handler in `backend-python/templates/`. The registry, type checker, and translator are all wired up. |
| **New invariant fields** | Low | Add to `ALLOWED_INVARIANT_FIELDS` set in `structure-types.ts:19`, handle in `structure-invariant.ts`, render in `normalizer/normalize.ts`. |
| **New CLI commands** | Low | The CLI uses Commander.js with dependency injection. Adding `stele diff` or `stele test` is a matter of adding a command module and wiring it in `index.ts`. |
| **New code-shape types** | Medium | Add a new variant to `CodeShapeDeclaration` union, parse in `structure-code-shape.ts`, evaluate in `cli/code-shape/evaluate.ts`. |
| **New violation kinds** | Low | The `Violation` model is generic. Adding `stele.check.xxx` violations is straightforward. |

### D.2 Requires Moderate Refactoring

| Extension | Effort | Why |
|-----------|--------|-----|
| **Wire custom operators into type checker** | Medium | `loadContract.ts` currently creates a fresh `createCoreOperatorRegistry()` in `validateTypes()`. Need to extract custom operator declarations from the Contract and register them. Requires defining how CDL operator declarations map to `OperatorSpec`. |
| **Runner integration (`stele test`)** | Medium | Add a command that invokes pytest/pytest-like runner. Need a `TestRunner` interface similar to `LanguageBackend`. |
| **Second language backend** | Medium-High | The `LanguageBackend` interface is ready. Implementing `generate()` for JavaScript/TypeScript, Go, or Rust requires a new `backend-*` package with its own translator and runtime. |
| **Checker with expression args** | Medium | Modify `encodeCheckerArgs` to accept translated CDL expressions, not just literals. Requires passing `TranslationContext` to checker arg encoding. |
| **Incremental validation** | Medium | Add a file-watching or hashing layer in `loadContract` to skip unchanged files. Requires tracking file mtimes or hashes. |

### D.3 Requires Significant Refactoring

| Extension | Effort | Why |
|-----------|--------|-----|
| **Full type system (subtyping, generics)** | High | The current type system is a flat enum (`SteleType`). Adding subtyping requires a type lattice, constraint solver, and unification. |
| **Distributed contract management** | High | Multi-repo contracts, contract inheritance, or cross-service contracts would require a network layer, contract resolution protocol, and distributed manifest. |
| **Live contract enforcement (runtime guard)** | High | Moving from test-time to runtime enforcement requires an agent SDK, instrumentation hooks, and performance analysis. |
| **CDL IDE support (LSP)** | High | Requires building a language server, completion provider, diagnostics, and go-to-definition for the CDL syntax. |

### D.4 New Packages That Make Sense

| Package | Purpose | Priority |
|---------|---------|----------|
| `@stele/backend-javascript` | Jest/Vitest test generation from CDL | High |
| `@stele/runner` | Abstract test runner interface (`run(contract, config) -> Result`) | High |
| `@stele/lsp` | Language Server Protocol for CDL editing | Medium |
| `@stele/diff` | Contract diff engine with invariant-level granularity | Medium |
| `@stele/sdk` | Programmatic API for embedding Stele in tools (CI, IDEs, agents) | Medium |

---

## E. Structural Observations

### Strengths

1. **Clean separation of concerns**: Core (parsing, validation), backend (generation), CLI (commands), plugin (IDE integration) are well-bounded.
2. **Immutable data patterns**: The codebase consistently creates new objects rather than mutating. `cloneOperatorSpec`, `normalizeOperatorSpec`, `createTranslationContext` all follow this pattern.
3. **Structured error model**: `SteleError` with codes, categories, spans, details, and hints provides excellent debugging support.
4. **Violation fingerprinting**: SHA-256 fingerprints for violations enable reliable baseline management and deduplication.
5. **Path safety**: Extensive path normalization and escape-prevention in `coordinator.ts` and `manifest.ts`.
6. **Operator registry design**: The `OperatorSpec` with `required`/`optional`/`variadic` parameters is well-designed for S-expression DSLs.

### Weaknesses

1. **`cli/code-shape/evaluate.ts` should be in core**: Code-shape evaluation is a core capability, not a CLI concern. Moving it would allow programmatic use.
2. **`STeleError` is in core but `CliCommandError` is in CLI**: The error hierarchy is split across packages. A unified error model would help.
3. **`normalizeContract` renders CDL from IR but loses formatting**: The normalizer produces canonical CDL but all original comments, spacing, and formatting are lost. This is fine for hashing but means Stele cannot be used as a CDL formatter.
4. **No version migration for manifest**: `MANIFEST_VERSION = "1"` is hardcoded. There is no migration path if the manifest format changes.
5. **`backend-python` translator has no abstraction for "expression rendering"**: The `translateExpression` function handles all operator translation in a single dispatch. For large operator sets, this becomes hard to navigate. (Mitigated by splitting into template files.)
6. **No configuration schema validation**: `stele.config.json` is read raw. There is no Zod/Joi schema for the config file. Invalid config fields are silently ignored.

---

## F. Security Observations

1. **Pre-tool hook is well-designed**: `scripts/pre-tool-protect.js` uses fail-closed error handling, validates protected patterns against absolute path and parent traversal, and uses `minimatch` with safe options.
2. **Import path escaping prevention**: `structure.ts:170` checks that imports stay within contract dir or project root.
3. **No secrets in codebase**: No hardcoded API keys, passwords, or tokens detected.
4. **Manifest path validation**: `validateManifestProtectedPath` (manifest.ts:260) rejects paths with `..`, backslashes, or absolute prefixes.
5. **Potential issue**: The `pre-tool-protect.js` script parses shell commands to detect write targets. The shell parser (`shell-utils.js`) is a simplified tokenizer -- complex shell constructs (subshell `$(...)`, command substitution `` `...` ``, arithmetic `$((...))`) may produce false negatives (missed protections) or false positives (blocked legitimate commands).

---

## G. Summary Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture clarity | 8/10 | Well-separated packages, clear data flow |
| Type safety | 7/10 | Good TS usage, but shallow type system for CDL |
| Operator coverage | 7/10 | 49 operators is solid for v0.1, missing modulo/pow/map-lookup |
| Language support | 3/10 | Python only |
| Test coverage | 6/10 | Core has tests, backend coverage is thin |
| CLI completeness | 6/10 | 15+ commands, but missing test runner and diff |
| Extensibility | 7/10 | LanguageBackend and OperatorRegistry interfaces are well-designed |
| Documentation | 5/10 | README is good, but CDL spec and API docs are thin |
| Production readiness | 5/10 | Works for the stated v0.1 target (Python + pytest), but gaps in workflow completeness |
