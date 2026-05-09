# Stele Monorepo — Unit Test Coverage Gap Report

> Generated: 2026-05-07
> Scope: All packages in the Stele monorepo

---

## Executive Summary

| Package | Source Files | Test Files | Tests | Coverage Est. | Verdict |
|---|---|---|---|---|---|
| `packages/core` | 19 | 10 | ~76 | ~35% | UNACCEPTABLE — core logic largely untested |
| `packages/cli` | 22 | 7 | ~100 | ~55% | INTEGRATION-HEAVY — commands tested, internals not |
| `packages/claude-code-plugin` | 1 (TS) + 5 (JS scripts) | 5 | ~50 | ~90% | SOLID — hook scripts well tested |
| `packages/backend-python` | 1 | 0 | 0 | 0% | CRITICAL — zero coverage |

**Overall monorepo estimated coverage: ~40%**

---

## packages/core — Detailed Gap Analysis

### File-by-File Coverage Map

| Source File | Lines | Direct Tests | Gap |
|---|---|---|---|
| `src/errors/SteleError.ts` | 15 | **0** | HIGH — foundational error class, zero tests |
| `src/ast/types.ts` | — | N/A | — (type definitions only) |
| `src/lexer/lexer.ts` | ~200 | 16 tests in `lexer.test.ts` | LOW — decent coverage, missing multi-line string, unicode edge cases |
| `src/lexer/token.ts` | ~50 | **0** | MEDIUM — token constructors, equality, stringification |
| `src/parser/parser.ts` | ~300 | 9 tests in `parser.test.ts` | MEDIUM — error codes E0101-E0103 covered; missing nested list, empty list, deeply nested parse |
| `src/loader/loadContract.ts` | ~200 | 2 tests in `loader.test.ts` | HIGH — recursive import depth limit, missing file, permission denied, symlink cycles |
| `src/validator/structure.ts` | ~1700 | 0 direct | **CRITICAL** — largest file, tested only indirectly via `loadContract` integration in `validator.test.ts` |
| `src/validator/references.ts` | ~50 | 0 direct | MEDIUM — E0307, E0308, E0316 covered via integration, but `validateReferences` not unit tested |
| `src/validator/uniqueness.ts` | ~80 | 0 direct | MEDIUM — E0306, E0312-E0319 covered via integration |
| `src/validator/types.ts` | ~200 | 0 direct | MEDIUM — type checker tested indirectly, but no granular operator type tests |
| `src/normalizer/normalize.ts` | ~150 | 4 tests in `normalizer.test.ts` | MEDIUM — missing circular reference normalization, empty contract normalization |
| `src/generator/coordinator.ts` | ~200 | 13 tests in `generator.test.ts` | LOW — LiteralBackend mocks, good coverage |
| `src/manifest/manifest.ts` | ~150 | 7 tests in `manifest.test.ts` | MEDIUM — missing write failure, concurrent access, malformed baseline |
| `src/registry/operators.ts` | ~400 | 7 tests in `registry.test.ts` | HIGH — 46 operators, only ~20 directly tested |
| `src/baseline/io.ts` | ~85 | **0** | HIGH — I/O with real filesystem, no error path tests |
| `src/baseline/types.ts` | ~60 | 2 tests in `baseline.test.ts` | MEDIUM — filterByScope missing edge cases |
| `src/report/format.ts` | ~135 | 3 tests in `report.test.ts` | MEDIUM — missing location variants, empty report, JSON circular ref |
| `src/report/types.ts` | ~50 | **0** | LOW — type definitions |
| `src/index.ts` | ~30 | **0** | LOW — re-exports, barrel file |

### HIGH Severity Gaps

**1. `src/errors/SteleError.ts` — Zero tests**
- File: `packages/core/tests/` — no test file
- Missing: Constructor parameters, `name` property, `code`/`category`/`span`/`detail`/`hint` fields, `instanceof` check, `message` inheritance
- Risk: Foundation of all error handling. Breaking change would go unnoticed.

**2. `src/baseline/io.ts` — Zero direct tests**
- File: `packages/core/src/baseline/io.ts` (85 lines)
- Missing: `readViolationBaseline` (malformed JSON, invalid shape, missing file), `writeViolationBaseline` (permission denied, non-directory parent), `tryReadViolationBaseline` (ENOENT vs other errors), `parseViolationBaseline` (invalid version, missing fields, bad fingerprint format)
- Risk: Filesystem I/O with real paths. Path injection, data corruption.

**3. `src/validator/structure.ts` — 1700 lines, zero direct unit tests**
- File: `packages/core/src/validator/structure.ts`
- This is the single largest file. All "coverage" comes from `validator.test.ts` calling `loadContract(rootPath)`, which internally invokes the parser, builder, and validators as a pipeline. No function is tested in isolation.
- Missing unit tests for:
  - `parseInvariantDeclaration` — all 14 optional fields, unknown field rejection, missing required fields
  - `parseScenarioDeclaration` — step kinds (step, capture-state), sandbox validation, executor validation
  - `parseCodeShapeDeclaration` — all 5 kinds (boundary, class-shape, function-shape, type-policy, file-policy), field validation per kind
  - `buildContract` — metadata merging, file aggregation, declaration collection
  - Internal validation: `TOP_LEVEL_DECLARATIONS` set enforcement, `ALLOWED_INVARIANT_FIELDS` validation
- Risk: 1700-line file is a maintenance nightmare. Refactoring would have no safety net.

**4. `src/registry/operators.ts` — 46 operators, ~20 tested**
- File: `packages/core/src/registry/operators.ts`
- 7 tests cover basic lookup, existence, arity for a subset. The remaining ~26 operators have no direct behavioral tests.
- Untested operators (approximate): `sum`, `where`, `forall`, `exists`, `path`, `collection`, `object`, `gen`, `ref`, `lt`, `lte`, `not`, `or`, `in`, `has`, `count`, `if`, and custom operator registration
- Risk: Operator logic errors silently produce wrong contract semantics.

### MEDIUM Severity Gaps

**5. `src/loader/loadContract.ts` — Only 2 tests**
- Missing: Import depth limit (100+ levels), missing `.stele` extension handling, non-existent import target, circular import beyond 2-file cycle, permission-denied file read, concurrent load of same file

**6. `src/validator/references.ts` — Integration-only coverage**
- `validateReferences` function not unit tested directly
- Missing: Cross-file checker references, self-referential depends-on, multiple invariants referencing same checker

**7. `src/validator/types.ts` — Indirect coverage**
- Type inference for complex expressions not tested at unit level
- Missing: Nested path types, quantifier type propagation, `Unknown` type widening

**8. `src/manifest/manifest.ts` — Partial coverage**
- Missing: `verifyBaseline` with outdated hashes, concurrent manifest writes, empty baseline comparison

**9. `src/normalizer/normalize.ts` — Partial coverage**
- Missing: Empty contract normalization, large contract performance, unicode in identifiers

**10. `src/generator/coordinator.ts` — Good, minor gaps**
- Missing: `verifyGenerated` with missing files, generator error propagation

### LOW Severity Gaps

**11. `src/lexer/token.ts` — Type definitions**
- Token construction, stringification, equality edge cases

**12. `src/report/format.ts` — Minor edge cases**
- Empty report formatting, all-suppressed violations, location without path

---

## packages/cli — Detailed Gap Analysis

### File-by-File Coverage Map

| Source File | Direct Tests | Gap |
|---|---|---|
| `src/index.ts` | Indirect (via CLI spawn) | MEDIUM — program wiring not unit tested |
| `src/commands/init.ts` | Via `cli.test.ts` fixtures | LOW |
| `src/commands/check.ts` | Via `cli.test.ts` fixtures | LOW |
| `src/commands/generate.ts` | Via `cli.test.ts` fixtures | LOW |
| `src/commands/lock.ts` | Via integration | MEDIUM — lock file format, concurrent lock |
| `src/commands/baseline.ts` | Via `baseline-diff.test.ts` | MEDIUM — baseline update edge cases |
| `src/commands/explain.ts` | Via `commands.test.ts` | LOW |
| `src/commands/list.ts` | Via `commands.test.ts`, `new-commands.test.ts` | LOW |
| `src/commands/rules.ts` | Via `commands.test.ts` | LOW |
| `src/commands/agentContext.ts` | Via `commands.test.ts` | LOW |
| `src/commands/why.ts` | Via `commands.test.ts` | MEDIUM — why analysis with no violations |
| `src/commands/propose.ts` | Via `new-commands.test.ts` | MEDIUM — proposal generation |
| `src/commands/dev.ts` | Via `new-commands.test.ts` | MEDIUM |
| `src/commands/doc.ts` | Via `new-commands.test.ts` | LOW |
| `src/commands/unlock.ts` | Via `new-commands.test.ts` | LOW |
| `src/commands/maintenance.ts` | Via `new-commands.test.ts` | MEDIUM |
| `src/commands/addChecker.ts` | **0** | HIGH — new command, zero tests |
| `src/code-shape/evaluate.ts` | 10 tests in `code-shape.test.ts` | MEDIUM — boundary, class-shape, function-shape covered; type-policy, file-policy partial |
| `src/config/loadConfig.ts` | **0** | MEDIUM — config loading, defaults, validation |
| `src/config/defaults.ts` | **0** | LOW — constants |
| `src/utils/ast-format.ts` | **0** | MEDIUM — AST formatting utilities |
| `src/utils/shared-utils.ts` | **0** | MEDIUM — shared utilities |
| `src/errors.ts` | **0** | MEDIUM — exit code mapping |

### HIGH Severity Gaps

**1. `src/commands/addChecker.ts` — New command, zero tests**
- Added in recent commit. No coverage in any test file.
- Missing: Happy path, invalid checker name, missing contract, permission errors

### MEDIUM Severity Gaps

**2. `src/config/loadConfig.ts` — Config loading untested**
- Missing: Missing config file, malformed config, deprecated fields, missing required fields

**3. `src/code-shape/evaluate.ts` — Partial coverage**
- `code-shape.test.ts` covers boundary, class-shape, function-shape evaluation
- Missing: Type-policy evaluation, file-policy evaluation, mixed code-shape scenarios

**4. `src/errors.ts` — Exit code mapping**
- No tests for error-to-exit-code mapping, which is critical for CI integration

---

## packages/claude-code-plugin — Detailed Gap Analysis

### Coverage Assessment

| Source | Tests | Verdict |
|---|---|---|
| `scripts/pre-tool-protect.js` | 30 tests | EXCELLENT — path normalization, Windows paths, BOM, Bash redirects, fail-closed |
| `scripts/lifecycle-context.js` | 4 tests | GOOD — SessionStart, UserPromptSubmit, PreToolUse, no-config |
| `scripts/observation-hook.js` | 3 tests | GOOD — PostToolUse recording, Bash write detection, no-config |
| `scripts/stop-validate.js` | 14 tests | EXCELLENT — stele failure, pytest failure, tool discovery, maintenance review |
| `hooks/hooks.json` | 3 tests | GOOD — schema validation, command names, agent frontmatter |
| `src/index.ts` | **0** | MEDIUM — plugin entry point not tested |

### Gaps

**1. `src/index.ts` — Plugin entry point**
- No tests for the main plugin registration, export surface, or initialization

**2. Cross-hook interaction tests**
- No tests that verify hooks work correctly when triggered in sequence
- Missing: PreToolUse denial followed by observation recording, lifecycle context + stop validate interaction

**3. Edge cases in `pre-tool-protect`**
- Missing: Very long paths (WIN32_MAX_PATH+), UNC paths, symlink resolution

---

## packages/backend-python — CRITICAL GAP

### `_stele_runtime.py` — 150 lines, zero tests

| Function | Risk | Missing Tests |
|---|---|---|
| `stele_get_path()` | HIGH — dict vs attribute access, KeyError paths, hyphen conversion | All code paths |
| `stele_is_modified()` | HIGH — before/after comparison, MISSING sentinel | All comparison cases |
| `stele_sum()` | MEDIUM — empty parts, non-numeric values | Empty list, bad types |
| `stele_call_checker()` | HIGH — registry lookup, dict result validation | Missing registry, missing checker, bad result shape |
| `stele_merge_contexts()` | HIGH — None handling, non-dict context | None merge, non-dict error |
| `stele_run_scenario()` | **CRITICAL** — dynamic import+call, sandbox context, step kinds | Full scenario execution |
| `_stele_call_python_import()` | HIGH — dynamic import, callable check | Bad module, missing function |
| `_stele_parse_python_import()` | MEDIUM — format validation | Invalid format, empty parts |
| `_stele_open_sandbox()` | MEDIUM — context manager detection, callable fallback | All branches |
| `_stele_resolve_scenario_value()` | HIGH — $ref, $gen resolution, nested dicts/lists | All resolution paths |
| `_stele_generate_value()` | LOW — unique-name generation | Generation |
| `_stele_read_optional_path()` | LOW — MISSING sentinel | Key error handling |

**Security Concern:** `stele_run_scenario` performs dynamic `importlib.import_module()` + `getattr()` calls. Without tests, there is no verification that arbitrary code execution is properly sandboxed.

---

## Test Infrastructure Assessment

### Strengths
1. **Vitest** configuration is solid across TypeScript packages
2. **Fixture-based integration testing** in `packages/cli` is excellent — 44 CLI workflow tests using real temp directories
3. **Plugin hook tests** use `spawnSync` to test scripts as subprocesses — matches real execution model
4. **Test cleanup** via `afterEach` with `Promise.allSettled` — robust temp directory management
5. **`LiteralBackend` mock** in generator tests — clean isolation from filesystem

### Weaknesses
1. **No Python test infrastructure** — `packages/backend-python` has no `tests/` directory, no `pytest.ini`, no `pyproject.toml` test config
2. **No shared test utilities** — each package duplicates `createTempProject`, `createTempDir`, helper functions
3. **No test coverage reporting** — no `v8` or `istanbul` coverage config in any package
4. **No E2E test suite** — no Playwright/Playwright-style E2E tests across the full stack
5. **No snapshot tests** — contract output, normalization, and formatting could benefit from snapshot testing

---

## Priority Remediation Plan

### Phase 1 — CRITICAL (Week 1-2)

| Task | File | Effort |
|---|---|---|
| Write `SteleError` unit tests | `tests/errors.test.ts` | 1h |
| Write `baseline/io` unit tests | `tests/baseline-io.test.ts` | 2h |
| Write `_stele_runtime.py` tests | `tests/test_stele_runtime.py` | 4h |
| Set up pytest infrastructure | `packages/backend-python/pyproject.toml` | 1h |

### Phase 2 — HIGH (Week 3-4)

| Task | File | Effort |
|---|---|---|
| Extract `structure.ts` unit tests | `tests/validator-structure.test.ts` | 8h |
| Complete operator registry tests | `tests/registry-operators.test.ts` | 4h |
| Write `addChecker` command tests | `tests/add-checker.test.ts` | 2h |
| Write `loadConfig` unit tests | `tests/config.test.ts` | 2h |

### Phase 3 — MEDIUM (Week 5-6)

| Task | File | Effort |
|---|---|---|
| Write `validateReferences` unit tests | `tests/validator-refs.test.ts` | 2h |
| Complete type checker tests | `tests/validator-types.test.ts` | 4h |
| Write `evaluate.ts` type-policy tests | `tests/code-shape-types.test.ts` | 2h |
| Write `shared-utils` tests | `tests/utils.test.ts` | 1h |
| Add coverage reporting | `vitest.config.ts` | 1h |

### Phase 4 — LOW (Ongoing)

| Task | Effort |
|---|---|
| Token type tests | 1h |
| Report format edge cases | 1h |
| Normalizer edge cases | 2h |
| Shared test utilities library | 3h |
| Snapshot testing migration | 4h |

---

## Summary Ratings

| Category | Score | Notes |
|---|---|---|
| Core logic coverage | 2/10 | 1700-line validator file with zero unit tests |
| CLI integration coverage | 7/10 | Fixture-based workflow tests are strong |
| Plugin hook coverage | 9/10 | Subprocess testing matches production model |
| Python backend coverage | 0/10 | Zero tests, dynamic code execution |
| Test infrastructure | 5/10 | Good Vitest setup, missing Python, no coverage reporting |
| **Overall** | **4.6/10** | Integration coverage is strong; unit test gaps are critical |
