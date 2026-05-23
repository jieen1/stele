# Round 6 synthesis — Round 5 re-audit + long-tail closure

Two independent Round 6 reviewers re-audited the Round 5 work:

- **Reviewer L** — regression hunter focused on bugs the Round 5
  implementer might have introduced WHILE closing Round 4 issues.
  10 findings (2 HIGH, 3 MED, 3 LOW, 2 INFO).
- **Reviewer M** — system-architecture + long-tail completeness auditor.
  18 findings (4 HIGH, 7 MED, 7 LOW).

## P0/HIGH fixes shipped this round

| Finding(s) | Fix |
|---|---|
| **L-01 / L-04** `_firstRealCommandIndex` returned the wrapper's own flag (e.g. `sudo -u root python3 -c …` returned idx=1 = `-u`) — every I-04 caller inherited the bypass | Wrapper-flag consumption loop now skips both the flag and (heuristically) its value, only stopping at a non-`-` token that isn't another wrapper. Catches sudo/nice/env/stdbuf/time/nohup-with-flag invocations across all four extractors (file-op, git checkout, interpreter, ln). |
| **L-02** D-13 inline `/* "…" */` block comments still injected phantom literals | Block-comment stripper replaced with a quote-aware state machine (`_strip_js_comments_quote_aware`) that tracks `"`/`'`/`` ` `` strings and only enters comment-strip mode outside quoted regions. Block + line comments anywhere on the line are stripped, but globs inside quoted strings (`packages/*/tsup.config.ts`, `**/*.stele`) survive. |
| **M-01** CLAUDE.md "eight publishable packages, 15 invariants" — actual: 17 packages, 35 invariants | Rewrote the package list (10 now mentioned + open-ended "run `pnpm -r ls` for the live list"); replaced "15 invariants" with "35 invariants — run `stele list`". |
| **M-02** Stray empty `packages/foo/.cursor/rules/` directory | Removed. |
| **M-03** Exit-code count drift across `contract/main.stele` invariant + checker descriptions + README | Three sites updated to "8 codes" (was 7); explicitly enumerates `SCORE_BELOW_THRESHOLD: 6`. |
| **M-04** Protected pattern `contract/checker_impls/**/*` was hashing `.pytest_cache/` + `__pycache__/` content into the manifest, producing churn on every pytest run | `walkProtectedRoot` skip-set extended to include `.pytest_cache` and `__pycache__`. Manifest dropped from 56 to 52 protected files (the 4 dropped were all ephemeral cache entries). |

## Items deferred to a later round

These were identified by Round 6 reviewers but the implementer chose to
defer (lower correctness risk, larger refactor surface, or duplicate of
known open items):

- **L-03** catch-body brace counter not string/template-literal aware
  (false-positive risk; today's hook scripts don't trigger it).
- **L-05** `observation-hook.js` bash-target extractor diverges from
  `pre-tool-protect.js` (audit log undercounts edits made via `ln` /
  `rsync` / interpreter `-c` / `git checkout`). Needs a shared
  `bash-extractors.js` module.
- **L-06** Round 5 synthesis claims "24-entry set" — actual is 23
  (docs-only fix; the synthesis is in `round-5-synthesis.md`).
- **L-07** K-03 `@stele/*` regex would flag a `@stele/cli` reference
  inside a single-line comment as if it were a real import. False
  positive risk only; no live false positive in the repo today.
- **L-08** J-13 still accepts whitespace-only `expected.cause.summary`
  (trim-then-check would close it).
- **L-09 / L-10** inherited or low-severity follow-ups.
- **M-05** 8 top-level CDL forms missing dedicated spec sections in
  `docs/spec/cdl.md` (boundary / class-shape / function-shape /
  type-policy / file-policy / branded-id / smart-ctor /
  type-state-binding / trace-policy / type-state).
- **M-06** Python guide doesn't document the F-A-02 fail-loud non-TS
  behavior.
- **M-07** `CLI_EXIT_CODE_ENUM_COMPLETE` checker only checks for the
  three class names, not the eight code values (the parallel
  `exit_codes_valid` checker now does enforce them).
- **M-08** `ALL_EVALUATORS_COMPILE` doesn't include `architecture-core`.
- **M-09** `cli-presentation` DDD module path
  `packages/cli/src/{commands,index}/**` still misses `index.ts`.
- **M-10** Approval ↔ proposal hash binding still absent.
- **M-11** Propose-flow exemplar YAML schema diverges from the CLI
  emitter's output shape.
- **M-12** F-A-07 Phase B propose has no tests.
- **M-13** `manifest_version_stable` doesn't compare to git HEAD.
- **M-14 / M-15** I-07 / J-04 carried over.
- **M-17** Round 5's five new dogfood opportunities (CJS require ban,
  `strict: true` lock, backward-compat shim ban, path-safety hot path,
  core purity scan) — none added.
- **M-18** `version.ts` uses `createRequire` — would need its own
  exception when the CJS-require ban (M-17 / dogfood) lands.

## Verified healthy (Round 6 closed correctly)

- L-01 wrapper-flag consumption verified: `sudo -u root cp foo
  contract/main.stele` now correctly returns idx 3 (=`cp`).
- L-02 quote-aware comment stripper verified: an inline `/* "x" */`
  next to a real entry no longer leaks `"x"` into the extracted set.
- M-01 / M-03 doc drift resolved across CLAUDE.md, main.stele, README.
- M-04 `.pytest_cache` / `__pycache__` no longer appear in the manifest
  (manifest dropped from 56 → 52 protected files).

## Test stats after Round 6

- agent-hooks: 197 / 197
- claude-code-plugin: 99 passed | 7 skipped
- pytest contract suite: 35 / 35
- `stele check`: 35 invariants, 52 protected files, exit 0

The repository remains green across the full test surface (no
regression introduced by Round 6 fixes).
