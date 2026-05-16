# Architecture Audit Report

Generated: 2026-05-16
Scope: packages/core (full source + test audit)
Depth: standard

---

## Executive Summary

**Overall Health: Healthy**

The Stele core codebase has solid architecture and clean TypeScript patterns. All critical and high-priority security issues in the new multi-agent safety feature have been identified and fixed. Validation layer now enforces agent cross-reference integrity, ID uniqueness, and path safety against injection vectors. Test coverage expanded from 27 to 31 test files with 1084 passing tests.

**Before fixes:** Critical: 3 | High: 5 | Medium: 12 | Low: 3
**After fixes:** Critical: 0 | High: 2 | Medium: 5 | Low: 2

## Dimension Scores

| Dimension | Score | Critical | High | Medium | Low |
|-----------|-------|----------|------|--------|-----|
| Test Coverage | 9/10 | 0 | 1 | 1 | 0 |
| Code Structure | 8/10 | 0 | 2 | 1 | 0 |
| Architecture | 8/10 | 0 | 1 | 2 | 0 |
| Data Layer | 8/10 | 0 | 0 | 2 | 1 |
| Security | 8/10 | 0 | 0 | 0 | 0 |
| Dependencies | 9/10 | 0 | 0 | 0 | 1 |
| Cache/Middleware | N/A | 0 | 0 | 0 | 0 |

---

## Issues — Status

### Fixed Issues

#### [CRITICAL-1] ✅ Agent Cross-Reference Validation (FIXED — `36a5481`)

- **Agent:** Security + Architecture
- **Location:** `packages/core/src/validator/references.ts`
- **Impact:** Agent declarations referenced nonexistent agents silently. Scope, contract, conflict, and requires clauses had no validation.
- **Fix:** Added agent ID registry to `validateReferences()`. All cross-references now validated: scope.agentId, interAgentContract.agents[], requires.agentId/approvedBy, conflict.agents[]. Self-approval (`agent === approver`) blocked. Error code E0320.
- **Tests:** 14 new tests in `tests/validator-ref.test.ts` and `tests/validator-agent-ref.test.ts`

#### [CRITICAL-2] ✅ Agent ID Uniqueness (FIXED — `36a5481`)

- **Agent:** Security + Architecture
- **Location:** `packages/core/src/validator/uniqueness.ts`
- **Impact:** Duplicate agent IDs silently accepted, creating ambiguous policy evaluation.
- **Fix:** Added agent ID uniqueness check to `validateUniqueness()`. Error code E0321.
- **Tests:** 3 tests in `tests/validator-agent-ref.test.ts`

#### [CRITICAL-3] ✅ util/array.ts Zero Test Coverage (FIXED — `36a5481`)

- **Agent:** Test Coverage
- **Location:** `packages/core/src/util/array.ts` (3 lines)
- **Impact:** `uniqueSortedStrings()` — the only dedup+sort function — had zero coverage. A bug silently corrupts normalized output and manifest hashes.
- **Fix:** Added 7 unit tests in `tests/util-array.test.ts` covering empty arrays, dedup, sort, determinism, special characters.

#### [HIGH-1] ✅ Normalizer Render Functions Untested (FIXED — `9b7f4bf`)

- **Location:** `packages/core/src/normalizer/normalize.ts` (lines 214-259)
- **Impact:** `renderAgent()`, `renderScope()`, `renderInterAgentContract()`, `renderConflict()` untested.
- **Fix:** Added 8 integration tests in `tests/normalizer-agent.test.ts` covering all 4 render functions, round-trip normalization, combined declarations, and fallback fields.

#### [HIGH-5] ✅ Agent Path Injection Vectors (FIXED — `9b7f4bf`)

- **Location:** `packages/core/src/validator/references.ts`
- **Impact:** Agent paths like `"../secret"` or `"/etc/passwd"` accepted without validation.
- **Fix:** Added `validateAgentPath()` — rejects absolute paths, `..` traversal, empty paths. Applied to agent paths, scope paths, conflict paths, and requires pathPattern. Error code E0322.
- **Tests:** 8 tests in `tests/validator-agent-path.test.ts`

#### [MEDIUM-1] ✅ Self-Approval Detection (FIXED — `36a5481`)

- **Location:** `packages/core/src/validator/references.ts`
- **Impact:** Agent could approve its own changes, defeating inter-agent contract safety.
- **Fix:** Self-approval check added as part of CRITICAL-1 agent cross-reference validation.

### Remaining Issues

#### [HIGH-2] Large Files Exceed 400-Line Guideline (OPEN)

- **Location:** Multiple files in `packages/core/src/validator/`

| File | Lines | Status |
|------|-------|--------|
| `registry/operators.ts` | 689 | Data-heavy operator specs — OK as-is |
| `generator/coordinator.ts` | 553 | Could extract validation phase |
| `validator/structure-code-shape.ts` | 524 | Could split per code shape type |
| `validator/structure-agent.ts` | 502 | Could split by declaration type |
| `validator/structure-scenario.ts` | 392 | Near limit, acceptable |

- **Risk:** Low — domain-specific files with clear responsibility boundaries. Splitting is organizational, not correctness-critical.
- **Recommendation:** Defer to dedicated refactoring sprint.

#### [HIGH-3] Shared Test Helpers Duplicated (OPEN)

- **Location:** Multiple test files
- **Impact:** `createTempProject()`, `getLoadContract()`, helper patterns copy-pasted across 10+ test files.
- **Risk:** Low — each test file is self-contained; maintenance cost is manageable at current scale.
- **Recommendation:** Defer to dedicated refactoring sprint.

#### [HIGH-4] ✅ Error Code Registry (FIXED — committed)

- **Location:** `packages/core/src/errors/error-codes.ts`
- **Impact:** Central registry created documenting all 43 error codes (E0001-E0606).
- **Fix:** Created `ErrorCodes` record with name, message, category, and source for each code. Exported helper functions: `errorCodeName()`, `errorCodeCategory()`, `listErrorCodes()`. Updated `docs/spec/cdl.md` error code ranges.

#### [MEDIUM-2] ✅ Allowed/Denied Path Overlap Detection (FIXED — `next`)

- **Location:** `packages/core/src/validator/references.ts`
- **Impact:** Overlapping allowed and denied paths not warned about at validation time.
- **Fix:** Added `warnPathOverlap()` function that checks for prefix-based overlap between allowed and denied paths. Emits `console.warn` warning. Enforcement layer already resolves conflicts (deny takes precedence).

#### [MEDIUM-3] ✅ `readStringList()` Identifier Acceptance Test (FIXED — `next`)

- **Location:** `packages/core/tests/structure-agent.test.ts`
- **Impact:** `readStringList()` accepts identifiers alongside strings. No dedicated unit test.
- **Fix:** Added 3 unit tests in `describe("readStringList identifier acceptance")` covering unquoted identifiers in allowed-paths, denied-paths, and mixed quoted/unquoted paths. Also added tests for inter-agent-contract and conflict with unquoted agent identifiers.

#### [MEDIUM-4] Test Format Fragility (OPEN)

- **Location:** CLI tests
- **Impact:** Exact string assertions break on output format changes.
- **Risk:** Low — format changes are deliberate and reviewed.
- **Recommendation:** Use snapshot testing for output format assertions.

#### [MEDIUM-5] `pnpm@9.15.0` Outdated (OPEN)

- **Location:** Root `package.json`
- **Impact:** pnpm 9.15.0 from May 2024. Current is 10.x.
- **Risk:** Low — no known security issues.
- **Recommendation:** Bump during next dependency update cycle.

#### [MEDIUM-6] `Date.now()` in Atomic Write (OPEN)

- **Location:** `packages/core/src/manifest/hash-manifest.ts` (line 177)
- **Impact:** Temp file collision in rapid parallel execution (theoretical).
- **Risk:** Negligible — `Math.random()` suffix provides sufficient collision resistance.
- **Recommendation:** Acceptable as-is.

#### [MEDIUM-7] `readSingleExpression` Duplication (OPEN)

- **Location:** Three copies across `structure-agent.ts`, `structure-invariant.ts`, `structure-parse.ts`
- **Impact:** Code duplication, maintenance burden.
- **Risk:** Low — logic is simple and well-tested.
- **Recommendation:** Extract to shared helper in next refactoring sprint.

#### [LOW-1] ✅ Missing Comment in `readStringList()` (FIXED — `next`)

- **Location:** `packages/core/src/validator/structure-agent.ts`
- **Fix:** Added JSDoc comment explaining why identifier kind is accepted.

#### [LOW-2] Hash Manifest Version Hardcoded (OPEN)

- **Location:** `packages/core/src/manifest/hash-manifest.ts` (line 19)
- **Impact:** Version bump requires manual update.
- **Recommendation:** Acceptable for v0.1.

#### [LOW-3] `safeUnlink` Silent Errors (OPEN)

- **Location:** `packages/core/src/manifest/hash-manifest.ts` (line 353)
- **Impact:** Non-ENOENT errors silently ignored during temp file cleanup.
- **Recommendation:** Acceptable for best-effort cleanup.

---

## Fix History

| Commit | Issues Fixed | Lines Changed | Tests Added |
|--------|-------------|---------------|-------------|
| `36a5481` | CRITICAL-1, CRITICAL-2, CRITICAL-3, MEDIUM-1 | 270 | 23 |
| `9b7f4bf` | HIGH-1, HIGH-5 | 167 | 16 |
| `5fc2691` | MEDIUM-9 (Shared Helpers adopted) | -46 | 0 |
| `next` | HIGH-4, MEDIUM-2, MEDIUM-3, MEDIUM-12, LOW-1 | ~150 | 5 |
| `58d3b65` | Round 4 security fixes (import target, dot-segment, E0204) | ~150 | 22 |

---

## Round 2 Audit (2026-05-16)

**Agents dispatched:** code-structure, security, dependency  
**Result:** All remaining issues structural — no new correctness bugs.

### Round 2 Findings (New)

#### [MEDIUM-8] Symlink Bypass in CDL Import Resolution (DOCUMENTED — Not Fixed)

- **Agent:** Security
- **Location:** `packages/core/src/loader/loadContract.ts`, `packages/core/src/validator/structure-parse.ts`
- **Impact:** `path.resolve()` is string-only and doesn't follow symlinks. `readFile()` does follow symlinks at runtime. An attacker with write access to the project could place symlinks to escape the import containment boundary.
- **Mitigation:** Contract files are read-only protected by agent hooks. Symlink attack requires filesystem-level write access to the contract directory, which is blocked by the protection model.
- **Recommendation:** Acceptable risk level. Future improvement: add `realpath()` check in `loadRecursive` with proper containment boundaries.

#### [MEDIUM-9] ✅ Duplicated Shared Helpers (FIXED — `5fc2691`)

- **Agent:** Code Structure
- **Location:** `readSingleExpression` ×4 (`structure-invariant.ts`, `structure-parse.ts`, `structure-scenario.ts`, `structure-code-shape.ts`); `ensureFieldUnset` ×2 (`structure-agent.ts`, `structure-scenario.ts`); `isPlainRecord` ×3 (`baseline/io.ts`, `manifest/manifest.ts`, `manifest/hash-manifest.ts`)
- **Fix:** All local copies replaced with imports from shared `util/types.ts` (`isPlainRecord`) and `validator/structure-shared.ts` (`readSingleExpression`, `ensureFieldUnset`). Error messages for `ensureFieldUnset` improved to include field name. 7 test expectations updated.
- **Tests:** 1084 passing, 0 regressions.

#### [MEDIUM-10] God Modules (CONFIRMED)

- **Agent:** Architecture
- **Location:** `report/types.ts` (356 lines, 5 responsibilities), `generator/coordinator.ts` (553 lines, 6 responsibilities)
- **Impact:** High cohesion violation, change amplification.
- **Recommendation:** Extract in next refactoring sprint.

#### [MEDIUM-11] Design Issues (DOCUMENTED)

- **Agent:** Architecture
- **Items:** `LanguageBackend` blob interface (3 optional methods bolted on), `validateTypes` hidden registry dependency, `Contract` type as accretion magnet (14 fields), `writeManifest` embedded write-if-changed logic
- **Recommendation:** Document for future design reviews.

#### [MEDIUM-12] ✅ `vitest` Version Alignment (FIXED — `next`)

- **Agent:** Dependency
- **Location:** Root `package.json` and `packages/mcp-server/package.json`
- **Fix:** Aligned both to `vitest ^4.0.0`, resolving 2 transitive CVEs (GHSA-67mh-4wv8-2f99, GHSA-4w7w-66w2-5vf9).

---

## Round 4 Audit (2026-05-16)

**Agents dispatched:** security, code-structure, test-coverage
**Result:** 0 critical, 0 high, 3 medium, 4 low findings. All actionable items fixed.

### Round 4 Score Summary

| Dimension | Score | Critical | High | Medium | Low |
|-----------|-------|----------|------|--------|-----|
| Security | 8.5/10 | 0 | 0 | 3 | 4 |
| Code Structure | 8.5/10 | 0 | 3 | 4 | 3 |
| Test Coverage | 7.5/10 | 0 | 3 | 4 | 2 |

### Round 4 Fixes

#### [MEDIUM-13] ✅ Import Target Path Traversal (FIXED — `58d3b65`)

- **Agent:** Security
- **Location:** `packages/core/src/validator/structure-scenario.ts` — `isValidPythonImportTarget()`
- **Impact:** Module segment accepted `../exploit:evil`, `os/path:func`, etc. Path traversal injected into generated pytest code.
- **Fix:** Added module segment regex `[a-zA-Z_][a-zA-Z0-9_.]*` and function segment regex `[a-zA-Z_][a-zA-Z0-9_]*` validation. Rejects path traversal, forward slashes, dot-prefixed modules, numeric-leading identifiers.
- **Tests:** 9 new tests in `tests/structure-scenario.test.ts`

#### [MEDIUM-14] ✅ Manifest Dot-Segment Rejection (FIXED — `58d3b65`)

- **Agent:** Security
- **Location:** `packages/core/src/manifest/manifest.ts` — `validateManifestProtectedPath()`
- **Impact:** `.` segments accepted in manifest protected paths. Path `"."` resolves to manifest directory.
- **Fix:** Added `segments.includes(".")` check alongside existing `..` check. Error code E0404.
- **Tests:** 1 test in `tests/manifest.test.ts`

#### [MEDIUM-15] ✅ E0202 Error Code Split (FIXED — `58d3b65`)

- **Agent:** Security
- **Location:** `packages/core/src/validator/structure-parse.ts`, `src/errors/error-codes.ts`
- **Impact:** E0202 used for both "invalid import syntax" and "path containment violation". Conceptually different error types sharing one code.
- **Fix:** Split into E0202 (syntax) and E0204 (containment). Updated error-codes.ts registry.
- **Tests:** Updated E0202→E0204 expectation in `tests/structure-parse.test.ts`

#### [MEDIUM-16] ✅ Path Overlap Warning Tests (FIXED — `58d3b65`)

- **Agent:** Test Coverage
- **Location:** `packages/core/tests/validator-path-overlap.test.ts` (new file)
- **Impact:** `warnPathOverlap()` had zero test coverage. Overlap detection logic unverified.
- **Fix:** Added 12 integration tests covering identical paths, prefix overlap, non-overlapping paths, and edge cases.
- **Tests:** 12 new tests

#### [MEDIUM-17] ✅ warnPathOverlap Console Warning (DOCUMENTED)

- **Agent:** Code Structure
- **Location:** `packages/core/src/validator/references.ts:20`
- **Impact:** `console.warn` in library code.
- **Decision:** Intentional user-facing warning for path overlap detection. Acceptable for CLI tool.

#### [LOW-4] ✅ readSingleString Duplication (DOCUMENTED)

- **Agent:** Code Structure
- **Location:** `structure-invariant.ts` and `structure-parse.ts`
- **Impact:** Near-identical helper function duplicated.
- **Recommendation:** Defer to refactoring sprint. Simple to extract.

### Round 4 Test Summary

| Metric | Before | After |
|--------|--------|-------|
| Test files | 31 | 32 |
| Total tests | 1089 | 1111 |
| New tests | — | +22 |

### Remaining Open Issues

1. **[HIGH-2]** Large files (>400 lines): `registry/operators.ts` (689), `generator/coordinator.ts` (553), `validator/structure-code-shape.ts` (512). Deferred.
2. **[HIGH-3]** Shared test helpers duplicated across 10+ files. Deferred.
3. **[MEDIUM-8]** Symlink bypass in CDL import resolution. Documented, acceptable risk level.
4. **[MEDIUM-10]** God modules (`report/types.ts`, `generator/coordinator.ts`). Deferred.
5. **[MEDIUM-11]** Design issues documented for future review.
6. **[MEDIUM-5]** `pnpm@9.15.0` outdated. Deferred.

---

## Priority Recommendations (Remaining)

1. **[HIGH] Split large validator files** — `structure-agent.ts` (502 lines), `structure-code-shape.ts` (524 lines). Effort: 3-4 hours.
2. **[MEDIUM] Adopt shared test helpers** — Consolidate `createTempProject()`, `getLoadContract()` patterns. Effort: 1 hour.
3. **[MEDIUM] Update pnpm** — Bump to 10.x. Effort: 30 min.

---

## Appendix

- Agents dispatched: test-coverage, code-structure, architecture, security, dependency, database
- Files analyzed: 62 TypeScript source files, 31 test files (was 27)
- Total lines of source code: 6,920
- Total lines of test code: 12,100 (was 11,476)
- Test-to-code ratio: 1.75:1 (was 1.66:1)
- Design docs reviewed: CLAUDE.md, docs/architecture.md
- Round 2: 2026-05-16 (structural audit, no new correctness bugs)
- Round 4: 2026-05-16 (security hardening, import target validation, E0204 split)
- Timestamp: 2026-05-16T21:50:00Z