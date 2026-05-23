# Round 4 synthesis — implementation re-audit + dogfood + known-issues backlog

3 independent reviewers ran in parallel against HEAD `484bc7f` (post Round 3
P0 + P1 closure). 67 raw findings, deduplicated to ~50 actionable items.

- Reviewer D — recent P0/P1 implementation re-audit (15 findings)
- Reviewer E — Stele dogfood audit (15 findings)
- Reviewer F — known-issues catalog (37 findings)

## Headline takeaways

### 1. P0 work was **incomplete** in 4 demonstrable ways

- **D-04 (CRITICAL)**: `tests/contract/conftest.py` never registered the
  three new Phase B self-protection checkers. `pytest tests/contract -q`
  fails with `KeyError` on every run — verified empirically. The P0-2 claim
  "CI enforces self-protection invariants" is therefore false at HEAD.
- **D-01**: P0-3 patched the plugin hook's UNION semantics but the CLI's
  `loadConfig` still REPLACEs. Manifest verification still trusts a
  narrowed user config.
- **D-02 + D-03**: P0-4 has two demonstrated bypasses — `stele design
  approve` is rubber-stampable (no signing, no hook protection on the
  approvals dir), and `stele design init --generate` hard-codes `force:
  true`.
- **D-07**: P0-6 wired `extern-alias` into trace-evaluator only; effect
  and type-state evaluators don't resolve aliases.

### 2. Defense-in-depth has known shell-level bypasses

- **D-05**: `ln -s`, `python -c`, `node -e`, `git checkout/restore`,
  `rsync`, `truncate`, quoted-heredoc `cat - > path` all bypass
  `pre-tool-protect.js`'s bash-target extraction.
- **D-06**: `matchProtectedPath` never `realpath`s the target; a symlink
  outside the project pointing at a protected file is invisible.
- **D-13**: Three independently-maintained "default protected" lists drift
  freely.

### 3. Stele is **not** using Stele

Most severe long-term concern (Reviewer E, E-01..E-08; Reviewer F, F-A-09):

| Mechanism | In contract | Should be |
| --- | --- | --- |
| `trace-policy` | 0 | ≥3 (path safety, hook fail-closed reachability, evaluator purity) |
| `type-state` | 0 | ≥1 (`Contract` lifecycle) |
| `effect-policy` | 0 | ≥2 (core engine purity, hooks bounded effects) |
| `boundary` | 0 | ≥1 (`@stele/core` no inbound `@stele/*` deps) |
| `function-shape` | 0 | ≥2 (branded ID adoption, hook entrypoint shape) |
| `file-policy` | 0 | ≥1 (ESM `.js` import suffix) |
| `class-shape` / `type-policy` | 0 | ≥0 (optional) |

CLAUDE.md rules like "Core engine is pure", "ESM `.js` extensions",
"Path safety is the hot path", "Hooks fail closed" are enforced by
**human review only**.

### 4. ~23 tests fail in the local env because of pytest absence + Windows path tests on Linux

Per-package counts (F-D-01..F-D-04): backend-python 10, cli 4, mcp-server 2,
conformance 7. These mask regressions — `pnpm test` is red for the wrong
reasons. All are skip-or-isolate fixes.

## Fix plan (by phase, ROI-sorted)

### Phase 1 — close P0 bypasses found by D
(estimated: ~3 hours)

1. **D-04** register Phase B checkers in `conftest.py` (CRITICAL — restores CI)
2. **D-01** mirror UNION semantics into CLI `loadConfig`
3. **D-02** protect `contract/design/approvals/**`; force approve.ts to write through hook-blocked Write
4. **D-03** drop `init --generate` auto-`force` (or restrict to interactive TTY)
5. **D-05** expand `pre-tool-protect.js` bash-target detection (ln, python -c, node -e, git checkout/restore, etc.)
6. **D-06** `realpath` symlinks in `matchProtectedPath`; fail-closed on EACCES
7. **D-07** thread `externAliases?` into `evaluateEffects` + `evaluateTypeStates`

### Phase 2 — defense-in-depth + supply chain
(estimated: ~3 hours)

8. **D-13** single source of truth for `DEFAULT_PROTECTED_PATTERNS` (import from `@stele/core` in all three places; add invariant asserting byte-equal)
9. **E-09** add `pnpm-lock.yaml`, `package.json`, `packages/*/package.json`, `packages/*/tsup.config.ts`, `.github/workflows/**`, `scripts/publish-npm.mjs` to protected
10. **E-11 + D-10** lenient-flag scanner extends to `package.json` scripts + `scripts/*.mjs|.py`
11. **F-A-02** Phase B stages on non-TS targets fail loud (`error` + `ok: false`)
12. **P2-1** `stop-validate.js` rejects `.stele/stop-state.json` if it's a symlink

### Phase 3 — dogfood Phase B (biggest correctness gap per E-01..E-08, F-A-09)
(estimated: ~4 hours)

13. **E-01** `(effect-policy CORE_PURE ...)` on `@stele/core`
14. **E-02** `(file-policy ESM_RELATIVE_IMPORTS_KEEP_JS)` on `packages/*/src/**/*.ts`
15. **E-03** `(trace-policy CLI_IO_VIA_PATH_UTILS)` for `packages/cli/src/commands/**`
16. **E-04** `(function-shape HOOK_ENTRYPOINTS_FAIL_CLOSED)` on all four hook scripts; widen `hooks_fail_closed` checker accordingly
17. **E-05** seed `contract/design/proposals/2026-…-e01-core-pure.yaml` + `contract/design/approvals/…` exemplar from #13 above (so the propose-flow has a real worked example)
18. **E-06** `(function-shape CORE_PUBLIC_API_USES_BRANDED_IDS)` on `@stele/core` loader / manifest public surface
19. **E-07** `(type-state CONTRACT_LIFECYCLE)` — unloaded → loaded → frozen
20. **E-08** `(boundary CORE_HAS_NO_STELE_DEPS)` forbidding `@stele/(cli|backend-*|agent-hooks|...)` imports in `@stele/core`

### Phase 4 — Round 3 P2 + remaining defects
(estimated: ~3 hours)

21. **F-A-07** extend `stele design propose <type>` to accept `trace-policy`, `type-state`, `effect-policy`, `effect-suppression`
22. **F-A-04** dead `_RULE_ID` audit
23. **F-A-05** `resolves_with` — wire or delete
24. **F-A-06** `ProvenanceRule.kind` widen for Phase B
25. **D-09** stronger structural FIX_HINT semantic check (require action verb in `[A]`)
26. **D-11** fix length-6 chain truncation marker
27. **D-12** relax conformance `cause.summary` comparator
28. **D-14** ESM `require()` in `approve.ts`
29. **D-15** drop dup `annotateCrossRuleViolations` in trace-evaluator
30. **P2-4 + P2-5 + P2-6** missing unit tests

### Phase 5 — docs + test env fragility
(estimated: ~3 hours)

31. **F-C-01 + F-C-03 + F-C-05 + F-C-06 + F-C-08 + E-12** doc + stub cleanup batch
32. **F-D-01..F-D-04** skip-if guards for env-only failures

## Total

~50 distinct actionable items grouped into 5 phases × ~3 hours = ~16
hours of focused work. Commit boundary chosen at the end of each phase.

## What is verified healthy

- P0-5 strictMode wiring (single emission site; correctly threaded).
- P0-6 parser + uniqueness validator (the wiring gap is the CLI plumbing,
  not the core machinery).
- P0-7 fix-hint flag references cleaned up.
- P1-1 CI workflow ordering is correct.
- P1-4 `annotateCrossRuleViolations` at the merge layer is idempotent and
  cleanly factored into `@stele/core`.
- P1-6 `effect_evidence` typed field; correctly excluded from fingerprint.
- P1-7 fail-fast fixture runner.
- P1-8 spec naming-history paragraph.
- `STRICT_MODE_DEFAULT_IN_CI`, `FIX_HINT_REQUIRES_ANALYSIS_BRANCH`,
  `ALL_EVALUATORS_COMPILE` invariants exist (the gap is conftest
  registration, not their content).
- 31 invariants + 18 architectures + 10 core-nodes + 4 branded-ids +
  3 smart-ctors all behaviour-tested with positive + negative pytest
  coverage (24 negative test cases pre-Round-4, 27 after Round 3 P1-2/P1-3).
