# Phase B Round 3 Review — Reviewer G (Security + Self-Protection Depth)

Audit baseline: HEAD `d64f7ad`, tag `v0.3.0-b1`. `stele check` reports OK 31 invariants. Verdict: **the maintainer's "agent cannot bypass Stele" claim is currently FALSE**. There are at least four working bypasses, and two of the new self-protection invariants do not run from `stele check` at all.

## Critical Security Gaps (must fix before claiming "agent independent maintenance")

1. **`.stele/stop-state.json` is not protected — direct Stop-hook loop-guard bypass.** `packages/claude-code-plugin/scripts/stop-validate.js:9` writes the loop-guard state to `.stele/stop-state.json`. Neither `packages/core/src/config/defaults.ts:8` (`DEFAULT_PROTECTED_PATTERNS`) nor `packages/claude-code-plugin/scripts/pre-tool-protect.js:30` (the fallback `DEFAULT_PROTECTED` list) nor this repo's `stele.config.json:11` lists `.stele/**`. Attack: agent runs `Edit .stele/stop-state.json` and pre-fills `{"lastFingerprint":"<known>","consecutiveAttempts":1,"releasedToUser":false}`. The next Stop-time failure with the matching fingerprint takes the `sameAsPrevious` branch at `stop-validate.js:574-595` and exits 0 — the human is never alerted to the *first* failure. The guard is purely advisory.

2. **`stele design generate` writes contract files with no approval check — agent escape via Bash.** `packages/cli/src/commands/design/generate.ts:47-77` calls `writeFileSync` against `contract/generated/ddd-typedriven.stele`, the manifest, and `contract/main.stele` (`ensureImportInMain`, line 81). The function never reads `contract/design/approvals/`. `packages/claude-code-plugin/scripts/pre-tool-protect.js:256-291` only intercepts shell `>`, `>>`, `tee`, `cp`, `mv`, `install`, `dd`; it does not pattern-match Stele CLI subcommands. Attack: agent runs `Bash: stele design generate`. The CLI process writes to all three protected paths without invoking the file-edit tools that the hook guards. The Stop-hook `stele check` afterward will not detect the change because the regenerated manifest matches the regenerated files. The protected glob is bypassed in one command.

3. **Hook scripts and `stele.config.json` are unprotected in this repo's config.** `pre-tool-protect.js:30-47` lists hook scripts and `stele.config.json` in `DEFAULT_PROTECTED`, but `loadConfig()` at line 93-110 replaces the default whenever the user config has a `protected` key. This repo's `stele.config.json:11-19` defines `protected` but omits the hook scripts and config itself. Agent in this repo can `Edit packages/claude-code-plugin/scripts/stop-validate.js` (e.g. change `STOP_BLOCK_EXIT_CODE` to 0, or short-circuit `blockStopWithLoopGuard`) — the pre-tool hook will not refuse. This is a complete kill switch with no defense.

4. **STRICT_MODE_DEFAULT_IN_CI and ALL_EVALUATORS_COMPILE never run from `stele check`.** I verified empirically: I dropped `.github/workflows/test.yml` containing `- run: stele check --lenient-effects` and ran `node packages/cli/dist/index.js check` — output: `OK 31 invariants checked`. The Python checker invoked directly (`python3 -c "from self_protection import strict_mode_default_in_ci; print(...)"`) correctly returns `passed: False`. So the Python *implementations* work, but the JS `stele check` does not call them. They only fire under `pytest tests/contract/` (test_contract.py:144-156). Projects without pytest (TypeScript/Go/Rust/Java adopters) never enforce these invariants. The 31-invariants OK headline is misleading.

5. **TS7016 shadows ALL_EVALUATORS_COMPILE.** Confirmed by negative test: moved `packages/effect-evaluator/dist/index.d.ts` aside, ran `stele check` — the output emitted three `typedriven.typescript.diagnostic.TS7016` errors. The ALL_EVALUATORS_COMPILE invariant never gets to report its dedicated message because the TS diagnostic stage runs first and short-circuits. The invariant is therefore dead code in the dist-missing scenario it was written to catch.

## Stop Hook Loop Guard

`blockStopWithLoopGuard` (`stop-validate.js:567-606`) is structurally correct:
- First failure: writes state, `process.exit(STOP_BLOCK_EXIT_CODE)` (=2) — block (line 605).
- Second matching fingerprint: writes state with `releasedToUser:true`, `process.exit(0)` — release (lines 577-594).
- Different fingerprint: takes the `sameAsPrevious === false` path → writes fresh state, blocks (lines 597-605).
- Successful run: `clearStopState()` (line 179) — zeroes the counter.

Tests at `packages/claude-code-plugin/tests/stop-validate.test.ts:125`, `:159`, `:181` cover all three transitions. Fingerprint normalization (line 614-622) strips ANSI, ISO timestamps, and 40+-char hex hashes; max 4096 chars. Adequate for run-to-run stability.

What's missing: the state file is **not protected**. See Critical Gap #1. Also note that the guard uses fingerprint-based release; agent could repeatedly cycle (write deliberate violation A → block → re-stop → release) on the second attempt. Each release lets the agent finish a turn; agent does not "win the contract" but does collapse the human-attention floor from two cycles to one.

## fix-hint A/B Real Enforcement

All three default fix-hint generators contain `[A]`, `[B]`, `code issue`, `contract issue`, `propose`:
- `packages/trace-evaluator/src/fix-hint-substitution.ts:126-153` — `defaultFixHint`. Step 4 says `Run \`stele design propose\`` and acknowledges the trace-policy-specific subcommand is "a planned follow-up", routing through `invariant`/`branded-id`/`aggregate` for now. Honest, but the agent is left to pick a closest-match kind.
- `packages/type-state-evaluator/src/fix-hint.ts:25-99` — `proposeExitText`, `defaultDisallowedOpFixHint`, `defaultInferenceFailedFixHint`. Same A/B shape, same "planned follow-up" caveat at line 31.
- `packages/effect-evaluator/src/fix-hint.ts:25-152` — three default*FixHint functions, all with explicit `[A]`/`[B]`. Same caveat at line 31.

The FIX_HINT_REQUIRES_ANALYSIS_BRANCH checker (`contract/checker_impls/self_protection.py:1148-1219`) extracts each `export function default*` body via brace-counting (line 1116-1145) and asserts each contains `code issue`, `contract issue`, `propose`, `[A]`, `[B]`. The keyword set is at `self_protection.py:1113`.

**Attack scenario tested conceptually**: a malicious fix-hint that drops `[A]` but keeps the three lowercase keywords. The checker explicitly compares `[A]`/`[B]` literally (line 1190-1192) — the agent cannot bypass by writing `(A)` instead. Good.

**Real weakness**: the checker is keyword-based, not semantic. An author who writes `[A] propose this code change to the contract issue` satisfies every keyword while *inverting* the meaning. The checker does not enforce ordering, surrounding text, or that the `[B]` branch routes to `stele design propose`. A genuinely hostile patch would still pass.

**The bigger problem**: as noted in Critical Gap #4, this invariant only runs under `pytest tests/contract/`. In a TS-only adopter, it never fires. The maintainer's "self-protection" guarantee here is conditional on Python being installed.

## Effect Suppression Bypass Resistance

`packages/effect-evaluator/src/suppression.ts:21` documents the design: `Source-code @stele:effects.suppress annotations are deliberately not supported`. Confirmed by inspection of `packages/backend-typescript/src/extractors/effect-annotations.ts:106-122`: the extractor only recognizes the `stele:effects` tag (and the `stele` + `:effects` two-token shape). It never reads `effects.suppress`. Adding `/** @stele:effects.suppress db.read */` to source code is silently ignored.

`packages/core/src/validator/structure-effect.ts:520-601` parses `(effect-suppression …)`. It enforces:
- `target` required (line 573-581);
- `suppresses` required and non-empty (line 583-591);
- `reason` required (line 593-601) — error code `E0357`;
- `reason` value's trimmed length must be > 0 (line 535-543) — also `E0357`.

This is the most disciplined area of Phase B. The bypass would require modifying `suppression.ts` or the extractor — both source files, neither of which is in any protected glob. Combined with Critical Gap #3 (the agent can edit hook scripts in this repo), an agent could in principle modify `suppression.ts` to honor source annotations. But the change would surface in `pnpm test` immediately (suppression tests at `packages/effect-evaluator/tests/suppression.test.ts` would break). Defense in depth holds here.

## Contract Protected Glob Completeness

`packages/core/src/config/defaults.ts:8` `DEFAULT_PROTECTED_PATTERNS` is the canonical default applied to new adopters via `stele init`:

```
contract/**/*.stele
contract/checker_impls/**/*
contract/.baseline.json
contract/.manifest.json
tests/contract/**/*
```

**Missing for Phase B**:
- `contract/design/profile.yaml`
- `contract/design/manifest.json`
- `contract/design/proposals/**` (already in `pre-tool-protect.js:34` fallback but NOT in core defaults)
- `contract/design/approvals/**`
- `contract/generated/**` (already in this repo's `stele.config.json:15` but not in defaults)
- `.stele/stop-state.json` (loop-guard bypass; Critical Gap #1)
- `packages/claude-code-plugin/scripts/*.js` (or, generically, the user's hook scripts directory)
- `packages/claude-code-plugin/hooks/hooks.json`
- `stele.config.json` (paradoxical: protecting the config requires the config to list itself)

`pre-tool-protect.js:30-47` partially compensates with a hardcoded `DEFAULT_PROTECTED`, but that list is shadowed the moment the user defines an explicit `protected` key in `stele.config.json` (line 97-99). Adopters who customize protected paths instantly lose the hook-script protection.

`contract/generated/effect-policies.stele` (referenced in the prompt) does not appear to exist on disk; only `contract/generated/ddd-typedriven.stele` is produced by `design generate`. No gap there.

## ALL_EVALUATORS_COMPILE Negative Test Result

Procedure: `mv packages/effect-evaluator/dist/index.d.ts /tmp/_save && node packages/cli/dist/index.js check`.

Output (truncated): three `typedriven.typescript.diagnostic.TS7016` errors against `check-stages-effect.ts`, `explain.ts`, `check-stages-effect.test.ts`. The TS diagnostic stage emits before the invariant-execution stage and `stele check` exits non-zero on the first error block. The dedicated `ALL_EVALUATORS_COMPILE` invariant message ("Some evaluator packages are not built…") never appears in output. The invariant is unreachable in its primary failure mode. Restored the file after the test.

Direct invocation of the Python implementation (`python3 -c "from self_protection import all_evaluators_compile; print(all_evaluators_compile({}))"`) correctly enumerates `dist/index.js` AND `dist/index.d.ts` for all five packages (`self_protection.py:1002-1054`), so the impl is correct — just unreachable from the CLI.

## STRICT_MODE_DEFAULT_IN_CI Negative Test Result

Procedure: created `.github/workflows/test.yml` containing `- run: stele check --lenient-effects`, ran `node packages/cli/dist/index.js check`.

Result: **OK 31 invariants checked**. The invariant did NOT fire.

Direct Python invocation: `passed: False`, `violations: [{file: '.github/workflows/test.yml', line: 4, column: 26, message: 'CI workflow uses lenient flag: - run: stele check --lenient-effects'}]`. The Python impl works (`self_protection.py:1057-1104`).

Conclusion: `stele check` does not run the `uses-checker` invariants at all. They are wired only through `tests/contract/test_contract.py:149-151` (pytest). In a Python adopter the Stop hook runs pytest so the gap is covered. In TS-only/Go/Rust/Java adopters the new invariants are never executed.

The Python checker has additional gaps even when invoked:
- Only literal `--lenient-` is matched (`self_protection.py:1082`). A workflow that exports `LENIENT="--lenient-effects"` then `run: stele check $LENIENT` passes.
- Calling a wrapper script (`run: ./ci/check.sh`) passes — the script's contents are not scanned.
- `--lenient-` substring will also flag innocuous text like a docstring `Use --lenient-effects to disable...`.

## Attack Surface Map (every Phase B trust decision)

| Surface | Agent can write? | Stele blocks? | Notes |
|---|---|---|---|
| CDL files (`contract/**/*.stele`) | Via Edit tool: no (protected). Via `stele design generate`: **yes** | **No** for the CLI path | Critical Gap #2 |
| `contract/design/profile.yaml` | Via Edit: blocked in this repo (`contract/design/**/*`); not in core defaults | Partial | Default profile.yaml unprotected for new adopters |
| `contract/design/proposals/**` | Yes (this is the intended channel) | N/A | Correct by design |
| `contract/design/approvals/**` | Yes (the agent's USER identity is taken from `CLAUDE_SESSION_ID/USER` env at `approve.ts:87`) | **No** | Agent could `stele design approve --reason 'self-approve'` |
| `contract/.manifest.json` / `contract/design/manifest.json` | Via Edit: blocked. Via `stele design generate`: rewritten freely | Partial | Same root cause as #2 |
| Evaluator `dist/` artifacts | Yes | **No** | ALL_EVALUATORS_COMPILE detects missing only; doctored dist files pass |
| Fix-hint source TS files (`fix-hint*.ts`) | Yes (not in any protected glob) | Partial | FIX_HINT_REQUIRES_ANALYSIS_BRANCH is keyword-only, not semantic; only runs under pytest |
| `.stele/stop-state.json` | **Yes** | **No** | Critical Gap #1 |
| Hook scripts (`packages/claude-code-plugin/scripts/*.js`) | **Yes** in this repo (config shadows DEFAULT_PROTECTED) | **No** | Critical Gap #3 — complete kill switch |
| `stele.config.json` | **Yes** in this repo (same shadowing) | **No** | Agent can rewrite `protected: []` |
| `.github/workflows/*` | Yes | Only if pytest runs | Critical Gap #4 |

The maintainer's "mechanical interlocks, no human in the hot path" claim does not survive this table.

## propose Flow Truthfulness

`packages/cli/src/commands/design/propose.ts:62-103`:
- Writes the proposal to `contract/design/proposals/<timestamp>-<id>.yaml` (line 79-80, 103). Confirmed.
- Checks for duplicate ids in current profile (lines 32-59) and in existing proposals (lines 66-77). Confirmed.
- Validates additivity by merging the proposal into a hypothetical profile and running `computeDesignDiff` (line 106-122). Rejects on `hasWeakening || hasRestructuring`. Confirmed.
- Does NOT modify `contract/design/profile.yaml`. Confirmed.

`stele design generate` does NOT consume proposals — see Critical Gap #2 and the `generate.ts:1-89` code: it reads `profile.yaml` directly and writes generated outputs. There is no `stele design approve` gate between `propose` and `generate`. The intended flow ("agent proposes → user reviews → user approves → generate") is **not enforced by code**. An agent that calls `stele design generate` skips propose entirely.

`stele design approve` (`approve.ts:1-94`) writes an approval JSON file but does NOT modify the profile and is NOT consulted by `generate`. The approval system is currently bookkeeping with no enforcement.

Proposal schema is documented at `docs/spec/cdl.md:993,1003,1113` (mentions the path and add-only rule, but no formal field-level schema). The implicit schema lives only in `propose.ts` (kinds: `invariant`, `branded-id`, `aggregate`).

## Defenses Verified

- Stop hook loop guard correctness (fingerprint same/different/cleared) — three test cases at `stop-validate.test.ts:125,159,181`.
- Source-code suppression annotation is silently ignored (`effect-annotations.ts:106-122` reads only `stele:effects`, never `effects.suppress`).
- E0357 enforces `(reason "…")` presence AND non-empty trimmed value (`structure-effect.ts:533-543, 593-601`).
- Fix-hint generators contain the required keywords (verified by reading all three files and matching against `_FIX_HINT_REQUIRED_KEYWORDS` at `self_protection.py:1113`).
- `propose.ts` blocks weakening/restructuring proposals via `computeDesignDiff`.
- `pre-tool-protect.js` symlink rejection at `stop-validate.js:418-421, 466-469` (Reviewer found earlier — defense remains intact).

## Specific Fix List (prioritized P0/P1/P2)

**P0 — block before next release**
1. Add `.stele/**` to `DEFAULT_PROTECTED_PATTERNS` (`packages/core/src/config/defaults.ts:8`) AND to this repo's `stele.config.json:11`. Without this, the loop-guard claim is fiction.
2. Make `stele design generate` refuse to run unless the current `profile.yaml`'s sha256 matches the latest `contract/design/approvals/*.json:approved_profile_sha256` field. Edit `generate.ts:20-46` to load the approvals dir and compare hashes; exit non-zero with a clear message ("profile.yaml drifted from latest approval; run `stele design approve --reason …` first") if mismatched.
3. Always union `DEFAULT_PROTECTED` (in `pre-tool-protect.js:30`) with the user's `protected` config — never replace. Then add `packages/claude-code-plugin/scripts/*.js`, `packages/claude-code-plugin/hooks/hooks.json`, and `stele.config.json` to the core `DEFAULT_PROTECTED_PATTERNS` so they survive adopter config customization. The current shadowing semantics is the single biggest design flaw.
4. Run `STRICT_MODE_DEFAULT_IN_CI`, `ALL_EVALUATORS_COMPILE`, `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` from `stele check` itself, not only from pytest. Either (a) port the three Python checkers to TS and register them as JS-side checker impls, or (b) have `stele check` spawn `python3 -m pytest tests/contract -q -k "self_protection or evaluators_compile or strict_mode or fix_hint"` as part of its pipeline (with a graceful skip if Python is absent, but a clear warning, not silent OK).

**P1 — fix in the next iteration**
5. Reorder check stages so `ALL_EVALUATORS_COMPILE` runs *before* the TS7016 diagnostic stage, OR teach the TS-diagnostic stage to call ALL_EVALUATORS_COMPILE first and emit its message when the cause is a missing dist. Right now TS7016 swallows the dedicated diagnostic.
6. Tighten STRICT_MODE_DEFAULT_IN_CI: scan referenced shell scripts, substitute simple shell vars, and ignore quoted strings inside YAML comments/keys.
7. Replace the keyword-only FIX_HINT_REQUIRES_ANALYSIS_BRANCH checker with a structural one (parse the TS, locate exported functions named `default*FixHint` returning a string literal, assert the return value's lines match the `[A]…[B]` shape). Today's checker is satisfied by `"[A] propose this code change to the contract issue"` — semantically inverted but syntactically valid.
8. Document the propose/approve/generate triple in `docs/spec/cdl.md` with an explicit "approvals gate generate" sentence (after fix #2 lands).

**P2 — nice to have**
9. Reject symlinked entries when reading `.stele/stop-state.json` (the symlink-rejection pattern in `stop-validate.js:418` is not applied to the state file itself).
10. Sign the loop-guard state file with an HMAC keyed by the project's `stele.config.json` content hash, so simple JSON edits to the state file are detected and treated as a fresh failure. Belt-and-braces atop fix #1.
11. Add a positive test that runs `node packages/cli/dist/index.js check` from a worktree with a `.github/workflows/*.yml` containing `--lenient-` and asserts the CLI exits non-zero. Currently no end-to-end test would have caught the silent-OK failure I reproduced manually.
