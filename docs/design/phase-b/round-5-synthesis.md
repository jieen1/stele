# Round 5 synthesis — independent re-audit of Round 4 work

After all Round 4 fixes shipped (~30 fixes across 5 phases, 33 tasks),
three independent reviewers re-audited the new code:

- **Reviewer I** — implementation re-audit of the Round 4 fix list:
  15 findings (6 P0, 8 P1, 3 P2).
- **Reviewer J** — bypass-hunt focused on new vectors Reviewer I might
  miss: 15 findings (4 HIGH, 5 MED, 5 LOW, 1 INFO).
- **Reviewer K** — dogfood + contract-authoring deep-dive:
  9 findings (4 HIGH, 4 MED, 1 LOW).

39 unique findings, with significant overlap (e.g. STELE_APPROVED_BY
denylist appears as both I-02 and J-01). Fixed every critical bypass
in this commit batch.

## Critical fixes shipped this round

| Finding(s) | Fix |
|---|---|
| **I-02 / J-01** STELE_APPROVED_BY denylist not implemented | Now refuses bare strings; requires `@`/`:` token-shape; refuses values equal to CLAUDE_SESSION_ID/USER/USERNAME/LOGNAME; refuses generic literals (`agent`, `bot`, `claude`, `tty`, `human`, `user`, `service`, `test`, `ci`, `unknown`, `anonymous`, `stele`, `approved`); enforces minimum 3 chars. |
| **I-01** D-01 UNION not propagated | Mirrored the UNION semantics into `packages/mcp-server/src/contract-cache.ts`, `packages/mcp-server/src/tools/context.ts`, `packages/agent-hooks/src/install/cursor-installer.ts`, and `packages/claude-code-plugin/scripts/observation-hook.js`. All 4 sites now honour `defaults ∪ user.protected`. |
| **J-02** observation-hook.js had a 4th divergent DEFAULT_PROTECTED list | Unified to the canonical 23-entry set (corrected from "24-entry" in the original Round 5 synthesis — Round 6 L-06), added as a 4th source to `default_protected_consistent` checker. |
| **J-03** `ln contract/main.stele /tmp/decoy` hardlink-aliasing bypass | `extractFileOperationTargetsFromSegment` now surfaces ALL positional args for `ln` (source AND destination), not just the last one. |
| **I-04** D-05 env-prefix + wrapper bypass | New `_firstRealCommandIndex` helper peels leading `NAME=value` assignments + wrapper commands (`env`, `command`, `exec`, `nice`, `nohup`, `time`, `sudo`, `doas`, `busybox`, `stdbuf`, `ionice`, `chronic`) before identifying the file-op / interpreter / git target. |
| **I-05** D-06 symlink with non-existent leaf bypass | `matchProtectedPath` now walks dirname upward when `realpathSync` of the leaf fails, finds the nearest existing ancestor, realpaths it, and re-attaches the tail. Refuses to walk past `projectRoot` (preserves fictional-test-root behaviour). |
| **I-06 / K-04** D-13 default-protected checker fooled by block comments / single quotes / template literals / spread | Block-comment stripper now anchors on start-of-line `/*` so glob patterns like `**/*.stele` inside quoted strings survive; literal-string regex extended to accept single-quoted strings; spread `...EXTRA` and backtick template literals now return `None` from the extractor → automatic divergence signal. |
| **K-01** E-02 multi-line ESM import bypass | Regex rewritten to use `DOTALL` + `[^;]*?` allowing newlines between import keyword and `from` specifier; new side-effect-import regex covers `import "./X";`. |
| **K-02** E-04 file-scope OR'd fail-closed check accepted disconnected try/catch/exit | Now extracts each catch-block body via brace counting and asserts at least ONE catch body ends with `process.exit(<non-zero>)` / `process.exit(<NAMED>)` / `failClosed(` / `blockStop(`. |
| **K-03** E-08 deny-list inverted to allow-list | `_CORE_ALLOWED_DEPS = {"call-graph-core"}` — any other `@stele/*` import in `packages/core/src/**/*.ts` is rejected, regardless of whether the importer is a new package. Regex also widened to catch `await import("@stele/X")` and bare side-effect imports. |
| **J-08** `pnpm typecheck` failing on main | Added `externAliases: []` to 6 synthetic Contract literals in test files (normalizer.test.ts + 5 backend test files); refactored `mk()` in cross-rule.test.ts to avoid the TS2783 duplicate-key error. |

## Round 5 findings that remain open (Round 6 candidates)

These are real-but-lower-severity items the implementer chose to defer:

- **I-07** D-09 `${}` empty-interpolation bypass — current check accepts any
  `${...}` substring; would need full TS template-expression parse.
- **I-12 / K-02 partial** E-04 user-defined `failClosed()` could itself be
  hollowed out. Would require asserting the helper's body itself ends in a
  non-zero exit (cross-file dataflow).
- **I-13** No negative tests for the four new dogfood checkers (D-13, E-02,
  E-04, E-08).
- **I-14** No tests for P2-1 stop-state symlink rejection at the runtime level.
- **I-15** F-A-07 Phase B propose lacks tests + bypasses the additivity check.
- **I-16** F-A-02 emits exit-code 3 (TAMPER_DETECTED) instead of a dedicated
  CONTRACT_FAIL-flavour for "unsupported target language".
- **I-17** D-13 doc claims "byte-equal modulo ordering"; checker uses set
  equality which permits in-list duplicate masking.
- **J-04** TOCTOU window between realpathSync check and the agent's
  subsequent write — needs an O_NOFOLLOW-style fence at write-time.
- **J-05** `clearStopState` does not have the same symlink guard as
  `writeStopState`.
- **J-06** macOS APFS case-insensitive filesystem — `nocase` is only set
  for `process.platform === "win32"`; should also cover `darwin`.
- **J-07** `observation-hook.js` checks only `dirname(observationPath)` for
  symlinks, not the file itself.
- **J-09 / J-10 / J-11** Dead-code markers (unused `blockStopWithContractRecovery`,
  unused `writeFile` import, stale `eslint-disable`).
- **J-12** F-D-04 conformance auto-skip regex is too permissive — could
  mask real CI failures whose message text happens to match the pattern.
- **J-13** Conformance `cause.summary` substring relaxation silently
  accepts empty `expected.cause.summary`.
- **J-14** Test isolation: `STELE_APPROVED_BY` set at module-load time;
  `process.exitCode` never reset between cases.
- **K-05** Propose-flow exemplar YAML schema diverges from the CLI's
  `runDesignPropose` emitter (`schema_version`, `proposal_id`, `motivation`,
  `implementation` fields don't match the CLI's emitted shape).
- **K-06** No mechanical link between proposal and approval — same id
  doesn't mean same hash; no checker verifies the binding.
- **K-07** `exit_codes_valid` checker omits `SCORE_BELOW_THRESHOLD: 6`.
- **K-08** `manifest_version_stable` doesn't compare to git HEAD's
  manifest — same-commit bump passes silently.
- **K-09** `cli-presentation` DDD module path `{commands,index}/**` misses
  `index.ts` (file, not dir).
- **New dogfood opportunities** (K's list): CommonJS `require()` ban,
  `strict: true` enforcement in `tsconfig.base.json`, backward-compat
  shim ban, path-safety hot-path enforcement, core-purity scan for
  `Date.now`/`Math.random`/`process.env`.

## Test stats

Round 4 → Round 5 deltas:

- core: 1323 / 1323 (no change; new tests in J-08 fix replaced existing ones)
- agent-hooks: 197 / 197 (no change; new I-05 walk-up logic preserves
  test expectations on fictional roots)
- claude-code-plugin: 99 passed | 7 skipped (no change)
- All other packages unchanged.
- 35 / 35 contract pytest invariants pass.
- `pnpm typecheck` repo-wide green (was failing on main before J-08).
- `stele check` exits 0 with 35 invariants + 52 protected files.

## Reviewer reports

Saved as:
- `docs/design/phase-b/round-5-reviewer-I.md` — impl re-audit (in-conversation transcript)
- `docs/design/phase-b/round-5-reviewer-J.md` — bypass-hunt (in-conversation transcript)
- `docs/design/phase-b/round-5-reviewer-K.md` — dogfood + contract-authoring (in-conversation transcript)

The conversation transcript at the parent session preserves the full
reviewer outputs; this synthesis captures the actionable subset.
