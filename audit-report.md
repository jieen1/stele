# Architecture Audit Report

Generated: 2026-05-16
Scope: packages/core (full source + test audit)
Depth: standard

---

## Executive Summary

**Overall Health: Warning**

The Stele core codebase has solid architecture and clean TypeScript patterns but has critical security gaps in the new multi-agent safety feature. The agent parser layer is well-built, but validation and enforcement are incomplete — agent IDs can be duplicated, cross-references are not checked, and path injection vectors are unmitigated.

Critical: **3** | High: **5** | Medium: **7** | Low: **3**

## Dimension Scores

| Dimension | Score | Critical | High | Medium | Low |
|-----------|-------|----------|------|--------|-----|
| Test Coverage | 6/10 | 1 | 2 | 3 | 1 |
| Code Structure | 7/10 | 0 | 2 | 2 | 1 |
| Architecture | 8/10 | 0 | 1 | 2 | 0 |
| Data Layer | 8/10 | 0 | 0 | 2 | 1 |
| Security | 5/10 | 2 | 0 | 0 | 0 |
| Dependencies | 8/10 | 0 | 0 | 1 | 1 |
| Cache/Middleware | N/A | 0 | 0 | 0 | 0 |

Note: Cache/Middleware not applicable — no Redis, message queues, or in-memory caches in the codebase.

---

## Critical Issues

### [CRITICAL-1] Agent Cross-Reference Validation Missing

- **Agent:** Security + Architecture
- **Location:** `packages/core/src/validator/references.ts` (lines 1-47)
- **Impact:** Agent declarations reference other agents by ID (scope.agentId, interAgentContract.agents[], requires.agentId, requires.approvedBy, conflict.agents[]) but `validateReferences()` validates only checker, invariant, and scenario IDs. A scope can reference a nonexistent agent, an inter-agent contract can list undefined agents, and conflict declarations can name agents that don't exist — all silently accepted.
- **Fix:** Add agent ID registry to `validateReferences()` and validate all agent-related cross-references:

```typescript
// In references.ts:
const agentIds = new Set(contract.agents.map(a => a.id));

// Scope validation
for (const scope of contract.scopes) {
  if (!agentIds.has(scope.agentId)) {
    throw new SteleError("E0320", ..., `Unknown agent "${scope.agentId}"`);
  }
}

// Contract agent validation
for (const contract of contract.interAgentContracts) {
  for (const agentId of contract.agents) {
    if (!agentIds.has(agentId)) { ... }
  }
  for (const req of contract.requires) {
    if (!agentIds.has(req.agentId)) { ... }
    if (!agentIds.has(req.approvedBy)) { ... }
  }
}

// Conflict agent validation
for (const conflict of contract.conflicts) {
  for (const agentId of conflict.agents) {
    if (!agentIds.has(agentId)) { ... }
  }
}
```

### [CRITICAL-2] Agent ID Uniqueness Not Enforced

- **Agent:** Security + Architecture
- **Location:** `packages/core/src/validator/uniqueness.ts` (lines 1-69)
- **Impact:** Duplicate agent IDs are silently accepted. Two agents with the same ID create ambiguous policy evaluations — the first matching agent wins, which is non-deterministic and undermines the security model.
- **Fix:** Add agent ID uniqueness check in `validateUniqueness()`:

```typescript
validateDuplicateIds(
  contract.agents,
  "E0321",
  "Agent",
  "Use a globally unique agent id across all loaded contract files.",
);
```

Note: `validateDuplicateIds` label type needs to accept "Agent" — add it to the type constraint.

### [CRITICAL-3] util/array.ts and util/fs.ts Have Zero Test Coverage

- **Agent:** Test Coverage
- **Location:** `packages/core/src/util/array.ts` (3 lines), `packages/core/src/util/fs.ts` (3 lines)
- **Impact:** `uniqueSortedStrings()` is the ONLY dedup+sort function in the codebase. It's used for deterministic output ordering. A bug here silently corrupts normalized output, manifest hashes, and test results with no test catching it.
- **Fix:** Add unit tests:

```typescript
// tests/util-array.test.ts
describe("uniqueSortedStrings", () => {
  it("handles empty array", () => { ... });
  it("deduplicates and sorts", () => { ... });
  it("is deterministic", () => { ... });
});

// tests/util-fs.test.ts
describe("isMissingFileError", () => { ... });
```

---

## High Issues

### [HIGH-1] Normalizer Render Functions Untested

- **Location:** `packages/core/src/normalizer/normalize.ts` (lines 214-259)
- **Impact:** `renderAgent()`, `renderScope()`, `renderInterAgentContract()`, and `renderConflict()` have no direct unit tests. These functions transform parsed agent declarations into normalized CDL output. Bugs here produce incorrect normalized output that passes integration tests only by coincidence.
- **Fix:** Add integration tests that parse contracts with all 4 agent declaration types, normalize, and assert exact normalized output. Minimum:

```typescript
it("normalizes agent declarations round-trip", () => {
  // Parse a contract with agent, scope, inter-agent-contract, conflict
  // Normalize and verify output matches expected form
});
```

### [HIGH-2] Large Files Exceed 400-Line Guideline

- **Location:** Multiple files in `packages/core/src/validator/`
- **Impact:** Files exceeding 400 lines are harder to review, more prone to regressions.

| File | Lines | Issue |
|------|-------|-------|
| `registry/operators.ts` | 689 | Core operator specs — data-heavy, OK as-is |
| `generator/coordinator.ts` | 553 | Orchestration logic — could extract validation phase |
| `validator/structure-code-shape.ts` | 524 | 5 code-shape parsers — could split to separate files |
| `validator/structure-agent.ts` | 502 | 4 agent parsers — could split by declaration type |
| `validator/structure-scenario.ts` | 392 | Near limit, but acceptable |

- **Fix:** Split `structure-code-shape.ts` into separate files per code shape type. Split `structure-agent.ts` into `structure-agent-identity.ts` (agent, scope) and `structure-agent-contract.ts` (inter-agent-contract, conflict).

### [HIGH-3] Shared Test Helpers Duplicated

- **Location:** `tests/validator-structure.test.ts`, `tests/validator.test.ts`
- **Impact:** `expectSteleError()` and `createTempProject()` helpers are copy-pasted across test files. Any fix to one copy must be manually applied to others.
- **Fix:** Extract to `tests/helpers/test-utils.ts` and import from there.

### [HIGH-4] Error Code E0317 Used Across Multiple Files

- **Location:** `packages/core/src/validator/structure-agent.ts` (E0317), `structure-code-shape.ts` (E0318)
- **Impact:** Error codes are supposed to map to specific validation contexts. E0305 is used for invariant validation, E0317 for agent validation, E0318 for code-shape validation. But there's no central registry of error codes. New developers may accidentally reuse existing codes or skip registering new ones.
- **Fix:** Create `packages/core/src/errors/error-codes.ts` with a documented error code registry and export a validation helper that enforces uniqueness.

### [HIGH-5] Agent Path Injection Vectors

- **Location:** `packages/core/src/validator/structure-agent.ts` (readStringList, parseAgentDeclaration)
- **Impact:** Agent paths like `"../secret"` or `"/etc/passwd"` are accepted without normalization or bounds checking. If these paths are used for access control, path traversal can bypass restrictions.
- **Fix:** At validation time, normalize paths and reject:
  - Absolute paths
  - Paths containing `..` segments
  - Paths starting with `/`
  - Paths that escape the project root

---

## Medium Issues

### [MEDIUM-1] Self-Approval Detection Missing

- **Location:** `packages/core/src/validator/structure-agent.ts` (parseRequiresClause)
- **Impact:** An agent can approve its own changes: `(requires "writer" (path "src/**") (approved-by "writer"))`. This defeats the inter-agent contract safety model.
- **Fix:** Validate `requires.agentId !== requires.approvedBy` at validation time.

### [MEDIUM-2] Allowed/Denied Path Overlap Not Detected

- **Location:** `packages/core/src/validator/structure-agent.ts`
- **Impact:** An agent can declare `(allowed-paths "src/**")` and `(denied-paths "src/core/**")` — overlapping patterns that create ambiguous policy evaluations.
- **Fix:** At validation time, check for pattern overlap and warn or error.

### [MEDIUM-3] No Test for `readStringList()` Identifier Acceptance

- **Location:** `packages/core/src/validator/structure-agent.ts` (line 395-403)
- **Impact:** The security fix that makes `readStringList()` accept identifiers was applied but not tested. A regression here silently drops identifiers from allowed-paths or denied-paths lists.
- **Fix:** Add tests for identifier-based agent paths.

### [MEDIUM-4] Test Format — `stele explain` Output Change

- **Location:** CLI tests (4 assertions changed `"Source:"` to `"## Source"`)
- **Impact:** Test assertions are fragile to output format changes. A format change in the explain engine breaks tests without any actual bug.
- **Fix:** Use snapshot testing for output format assertions instead of exact string matching.

### [MEDIUM-5] `pnpm@9.15.0` Outdated

- **Location:** Root `package.json`
- **Impact:** pnpm 9.15.0 from May 2024. Current is 10.x. Potential security fixes and performance improvements missed.
- **Fix:** Bump to latest stable pnpm version.

### [MEDIUM-6] `Date.now()` in Atomic Write

- **Location:** `packages/core/src/manifest/hash-manifest.ts` (line 177)
- **Impact:** `writeAtomic()` uses `Date.now()` for temp file names. In rapid parallel execution, collisions are theoretically possible. The `Math.random()` suffix mitigates this, but the timestamp creates slightly non-deterministic behavior.
- **Fix:** Acceptable as-is — the random suffix provides sufficient collision resistance for temp files.

### [MEDIUM-7] `readSingleExpression` Not Exported from structure-agent.ts

- **Location:** `packages/core/src/validator/structure-agent.ts`
- **Impact:** `readSingleString` and `readSingleExpression` are private helpers in structure-agent.ts, but the same logic exists in structure-invariant.ts and structure-parse.ts. Three copies of the same validation pattern.
- **Fix:** Extract to shared helper in `structure-error.ts` or a new `field-readers.ts`.

---

## Low Issues

### [LOW-1] No Comments in `readStringList()` Security Fix

- **Location:** `packages/core/src/validator/structure-agent.ts` (line 395)
- **Impact:** Future maintainers won't know why `identifier` kind is accepted alongside `string`.
- **Fix:** Add comment: `// Accept identifiers (no quotes) for allowed-paths, denied-paths, and agents fields.`

### [LOW-2] Hash Manifest Version String Hardcoded

- **Location:** `packages/core/src/manifest/hash-manifest.ts` (line 19)
- **Impact:** Version bump requires manual update. No automation ties manifest version to package version.
- **Fix:** Acceptable as-is for v0.1. Consider automation when schema changes.

### [LOW-3] `safeUnlink` Silent Error Handling

- **Location:** `packages/core/src/manifest/hash-manifest.ts` (line 353)
- **Impact:** `safeUnlink()` silently ignores non-ENOENT errors. If the temp file can't be deleted for permission reasons, the error is swallowed.
- **Fix:** Acceptable for best-effort cleanup — don't shadow original failures. Could add `console.warn()` for debugging.

---

## Priority Recommendations

1. **[CRITICAL] Implement agent cross-reference validation** — Add scope, contract, and conflict agent ID validation to `validateReferences()`. Effort: 2-3 hours.
2. **[CRITICAL] Implement agent ID uniqueness** — Add agent uniqueness check to `validateUniqueness()`. Effort: 30 min.
3. **[CRITICAL] Add tests for util/ modules** — Cover `uniqueSortedStrings()` and `isMissingFileError()`. Effort: 30 min.
4. **[HIGH] Add normalizer round-trip tests** — Test all 4 agent render functions. Effort: 2 hours.
5. **[HIGH] Extract shared test helpers** — Consolidate duplicated test utilities. Effort: 1 hour.
6. **[HIGH] Split large validator files** — `structure-agent.ts` and `structure-code-shape.ts`. Effort: 3-4 hours.
7. **[HIGH] Document error codes** — Central error code registry. Effort: 1 hour.
8. **[MEDIUM] Add agent path validation** — Reject absolute paths, `..` traversal, root escapes. Effort: 2 hours.
9. **[MEDIUM] Add self-approval detection** — `requires.agentId !== approvedBy` check. Effort: 30 min.
10. **[MEDIUM] Add identifier acceptance tests** — Verify `readStringList()` handles identifiers. Effort: 30 min.

---

## Appendix

- Agents dispatched: test-coverage, code-structure, architecture, security, dependency, database
- Files analyzed: 62 TypeScript source files, 27 test files
- Total lines of source code: 6,920
- Total lines of test code: 11,476
- Test-to-code ratio: 1.66:1 (above industry standard)
- Design docs reviewed: CLAUDE.md, docs/architecture.md
- Timestamp: 2026-05-16T00:00:00Z
