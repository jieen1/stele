# Architecture Audit Report
Generated: 2026-05-22
Scope: E:\project\stele (full monorepo)
Depth: standard

## Executive Summary
Overall Health: **Warning**
Critical: 4 | High: 8 | Medium: 12 | Low: 6

## Dimension Scores
| Dimension | Score | Critical | High | Medium | Low |
|-----------|-------|----------|------|--------|-----|
| Code Structure | 6/10 | 3 | 5 | 10 | 3 |
| Security | 6/10 | 2 | 5 | 4 | 3 |
| Test Coverage | 7.2/10 | 5 | 7 | 8 | 0 |
| Dependencies | 7/10 | 0 | 0 | 1 | 2 |
| Architecture | 7/10 | 4 | 0 | 3 | 1 |

---

## Critical Issues (sorted by impact)

### [CRITICAL-1] Prototype Pollution via yaml.load()
- **Agent:** Security
- **Location:** `packages/cli/src/commands/design/approve.ts:49,124`
- **Impact:** `yaml.load()` allows `!!js/object` and `!!js/function` tags. If a design profile YAML is sourced from untrusted location, prototype pollution possible.
- **Fix:** Replace `yaml.load()` with `yaml.safeLoad()`. 5 min effort.

### [CRITICAL-2] Command Injection via js-yaml Merge Key (GHSA-mh29-5h37-fv8m)
- **Agent:** Dependency + Security
- **Location:** `packages/cli/package.json` — js-yaml pinned at `4.1.0`
- **Impact:** YAML merge key (`<<`) injects arbitrary properties. CVSS ~6.5.
- **Fix:** Upgrade js-yaml to `^4.1.1`. Run `pnpm install`. 5 min effort.

### [CRITICAL-3] Shell Injection in E2E Test
- **Agent:** Security
- **Location:** `packages/cli/tests/e2e-workflow.test.ts:24`
- **Impact:** `execAsync` with unescaped args. `args.join(" ")` allows shell metacharacter injection.
- **Fix:** Use `execFile` with args array. 10 min effort.

### [CRITICAL-4] God Classes — 3 Files >1000 Lines
- **Agent:** Structure + Architecture
- **Location:**
  - `packages/cli/src/code-shape/evaluate.ts` (1338 lines)
  - `packages/cli/src/commands/check.ts` (1158 lines)
  - `packages/backend-typescript/src/translator.ts` (1577 lines)
- **Impact:** Hard to maintain, hard to test, violates single responsibility.
- **Fix:** Split into domain-specific modules. 8-16 hours total.

---

## High Issues

| # | Issue | Location | Fix | Effort |
|---|-------|----------|-----|--------|
| 1 | Symlink protection incomplete for git/python/pnpm | `stop-validate.js`, `lifecycle-context.js` | Extend symlink rejection pattern | 30 min |
| 2 | Bash tool detection case-sensitive | `pre-tool-protect.js:214`, `observation-hook.js:169` | `toLowerCase()` comparison | 5 min |
| 3 | No timeout on spawned processes | Hook scripts, `check.ts:942` | Add timeout/maxBuffer | 15 min |
| 4 | Shell metacharacters in design profile commands | `command-resolver.ts` + `check.ts:942` shell:true Windows | Sanitize tokens | 30 min |
| 5 | Untested CLI commands: check-diff, pre-commit, cache, score, rules | `packages/cli/src/commands/` | Write tests | 4-6 hours |
| 6 | Untested MCP server paths: stele-binary, bin/mcp-server | `packages/mcp-server/src/` | Write tests | 2-3 hours |
| 7 | 178 `toBeDefined()` broad assertions | 54 test files | Replace with specific value checks | 8-12 hours |
| 8 | Hook script duplication | `pre-tool-protect.js` + `observation-hook.js` | Extract shared modules | 1 hour |

---

## Medium Issues (selected)

| # | Issue | Location |
|---|-------|----------|
| 1 | Operator registry 689 lines — split by category | `packages/core/src/registry/operators.ts` |
| 2 | core-report dep from core-domain-services (DDD violation) | `evaluator/explain.ts` imports `report/types.js` |
| 3 | Design profile validation duplicated | `design-profile/validate.ts` + `validator/structure-architecture.ts` |
| 4 | Magic values (String.fromCharCode) in typescript-metrics.ts | `packages/cli/src/complexity/typescript-metrics.ts:12` |
| 5 | Silent error swallowing in observation/lifecycle hooks | `observation-hook.js:62`, `lifecycle-context.js:53` |
| 6 | architecture-core types leaking into CLI app layer | `cli/src/architecture/stage.ts` |
| 7 | shared-utils.ts has 12 unrelated functions | `packages/cli/src/utils/shared-utils.ts` |
| 8 | Backend Go/Rust/Java translators >800 lines | `backend-go`, `backend-rust` |
| 9 | @vercel/ncc abandoned (GH action bundling) | `packages/github-action/package.json` |
| 10 | Circular workspace peer dep: agent-hooks <-> cli | package.json peer deps |

---

## Stele Self-Protection Assessment

**Contract health:** 27 invariants pass. `stele check` exit 0.

**Protected files:**
- `contract/main.stele` — 30 checkers, 27 invariants. Well organized by category.
- `contract/generated/ddd-typedriven.stele` — 9 architecture declarations, 10 core nodes. Comprehensive DDD boundaries.
- `contract/checker_impls/` — 2 Python checkers (self_protection.py, test_negative.py). Minimal.
- `stele.config.json` — 10 protected patterns. Includes `contract/generated/**/*`.

**Hook health:**
- PreToolUse: Blocks writes to protected paths. Fail-closed. ✓
- Stop: Runs stele check + pytest + pnpm test. Fail-closed. ✓
- SessionStart: Injects contract context. Fail-open (correct). ✓
- Observation: Records material edits. Fail-open (correct). ✓

**Issues found:**
1. Hook scripts (500+ lines each) have duplicated logic. Extract shared modules.
2. Bash detection is case-sensitive. Runtime casing change would bypass.
3. No timeout on spawned stele/pytest processes.

**Config review:**
- Protected patterns comprehensive. Includes design/, proposals/, generated/, baseline, manifest.
- No escape patterns (no `..`, no absolute paths).
- `contract/generated/ddd-typedriven.stele` has detailed architecture + core-node declarations.

---

## Priority Recommendations

### P0 — Immediate (Exploitable)
1. Replace `yaml.load()` with `yaml.safeLoad()` in `approve.ts` (2 lines)
2. Upgrade `js-yaml` from `4.1.0` to `^4.1.1` in `packages/cli/package.json`
3. Fix shell injection in e2e test — use `execFile` with args array

### P1 — Short Term (Security Hardening)
4. Make Bash tool detection case-insensitive (2 files, 2 lines each)
5. Add symlink rejection to git/python/pnpm resolution
6. Add timeout to spawned processes in hook scripts + check.ts

### P2 — Medium Term (Structure)
7. Split god files: evaluate.ts, check.ts, translator.ts
8. Deduplicate hook script shared logic
9. Fix core-report dependency direction (DDD violation)
10. Write tests for untested CLI commands

### P3 — Long Term (Hygiene)
11. Replace 178 `toBeDefined()` assertions
12. Split operator registry by category
13. Standardize file naming (kebab-case)
14. Update architecture documentation (11 packages, not 4)
15. Remove `packages/foo` empty directory

---

## Appendix
- Agents dispatched: code-structure, security, test-coverage, dependency, architecture
- Files analyzed: ~150+ source files across 12 packages
- Design docs reviewed: CLAUDE.md, docs/architecture.md, contract/main.stele, contract/generated/ddd-typedriven.stele
- Timestamp: 2026-05-22
