# Reviewer D — Round 3 P0/P1 implementation audit (2026-05-23)

Independent re-audit of the 21 commits `49e3449..484bc7f` that landed Round 3
P0 and P1 fixes. Conducted by an isolated sub-agent with no access to the
P0/P1 author's planning notes.

## Severity legend

- 🔴 P0-bug: bypass / correctness / data loss
- 🟡 P1-bug: missing coverage / edge case / docs gap
- 🟢 P2-bug: nit / minor improvement

## Findings

### D-01 🔴 CLI `loadConfig` still REPLACES `protected` (P0-3 only half-applied)

**Where**: `packages/cli/src/config/loadConfig.ts:40-42`

The plugin's `pre-tool-protect.js` was changed to UNION default + user
patterns (P0-3 fix), but the CLI's `loadConfig` still does the legacy
replace
(`Object.prototype.hasOwnProperty.call(parsed, "protected") ? readProtectedConfig(parsed.protected) : [...DEFAULT_CONFIG.protected]`).
So `stele check`, `stele lock`, and `stele generate` (which all collect
protected paths via `collectProtectedPaths(projectDir, config)` in
`generate.ts:394`) honor a narrower user list. A user / tampered config
that omits hook-script entries means manifest verification no longer
fingerprints those scripts. Defense-in-depth is broken below the hook
layer.

**Fix**: Mirror the union semantics in `loadConfig.ts`:
`const userPatterns = …; return [...new Set([...DEFAULT_CONFIG.protected, ...userPatterns])]`.

### D-02 🔴 P0-4 approval gate is rubber-stampable by the agent

**Where**: `packages/cli/src/commands/design/approve.ts:20-94`

`runDesignApprove` requires only `--reason` (a string, no signing). It
writes the approval record into `contract/design/approvals/` — a directory
that is **not** in any of the three default-protected lists. `approved_by`
defaults to env vars (`CLAUDE_SESSION_ID` / `USER`), which the agent
controls. So an agent can do `stele design approve --reason "x"` followed
by `stele design generate`, fully bypassing P0-4's intent.

**Fix**: Either (a) require an out-of-band human-signed `approval.json`
(HMAC keyed on a secret the user keeps), or (b) protect
`contract/design/approvals/**` and require a Write event (which the plugin
blocks) — forcing the user to author the record. Refuse env-var values for
`approved_by`.

### D-03 🔴 `stele design init --generate` auto-bypasses the P0-4 approval gate

**Where**: `packages/cli/src/commands/design/init.ts:314-323`

`runDesignInit` invokes `runDesignGenerate` with hard-coded
`{ force: true, reason: "stele design init --generate (preset: …)" }`. The
Bash command `stele design init --generate --preset ddd-typedriven`
therefore writes to all three protected paths without any approval record.
The comment claims "the human is the one who just declared intent" — but an
agent running `init --generate` is not a human. `pre-tool-protect.js`
doesn't introspect `stele …` Bash invocations.

**Fix**: Make `init --generate` write an approval record itself (with a
session-level human flag set only by interactive `stele design init`), OR
remove the auto-force and force `init --generate` users through the same
`approve` flow.

### D-04 🔴 New Phase B self-protection tests fail with KeyError (P0-2/P0-8 incomplete)

**Where**: `tests/contract/conftest.py:33-63, 67-98`

`contract/main.stele:291-313` declares three new invariants
(ALL_EVALUATORS_COMPILE, STRICT_MODE_DEFAULT_IN_CI,
FIX_HINT_REQUIRES_ANALYSIS_BRANCH).
`tests/contract/test_contract.py:144-156` calls
`stele_call_checker("all-evaluators-compile", …)` etc.
`contract/checker_impls/self_protection.py:1011/1104/1305` defines the three
Python functions. **But `conftest.py` neither registers them in
`_lazy_load_checkers`'s tuple (lines 33-63) nor maps them in
`_CHECKER_NAME_MAP` (lines 67-98).** As a result `stele_call_checker` raises
`KeyError: Stele checker not registered: …` and the three tests **fail with
KeyError on every pytest run**.

```
FAILED tests/contract/test_contract.py::test_ALL_EVALUATORS_COMPILE — KeyError
FAILED tests/contract/test_contract.py::test_STRICT_MODE_DEFAULT_IN_CI
FAILED tests/contract/test_contract.py::test_FIX_HINT_REQUIRES_ANALYSIS_BRANCH
```

The Round 3 P0-2 claim "stele check + pytest enforce the new invariants in
CI" is therefore **empirically false** — `python -m pytest tests/contract -q`
in `ci.yml` would mark these three tests red.

**Fix**: Add the three names to the registration tuple and the name map in
`conftest.py`. Re-run `pnpm test:packed-adoption` to verify.

### D-05 🔴 `ln -s` and interpreter writes bypass `pre-tool-protect.js`

**Where**: `packages/claude-code-plugin/scripts/pre-tool-protect.js:377-432`

`extractFileOperationTargets` recognizes only `cp`, `mv`, `install` plus
tee/dd/`>`/`>>`. Bypass paths:

- `ln -s /tmp/malicious .stele/stop-state.json` (symlink swap)
- `python -c "open('.stele/stop-state.json','w')…"` (interpreter write)
- `node -e "fs.writeFileSync(…)"`, `perl -e`, `rsync`, `truncate`
- `chmod` / `chown`
- `git checkout <file>` / `git restore` (overwrite from history)
- `cat - > path` in a quoted heredoc

P0-1's claim that `.stele/stop-state.json` is rejected by all write paths
is only true for the specific shell idioms enumerated.

**Fix**: Expand `commands` set to include `ln`, `rsync`, `truncate`. For
interpreters and `git checkout/restore`, default-deny any Bash command
whose top-level word is not on a small allowed list when the command
writes to any protected glob target.

### D-06 🔴 Symlink replacement bypasses `matchProtectedPath`

**Where**: `packages/agent-hooks/src/util/path-glob.ts:25-60`

`matchProtectedPath` operates on the literal target string; it never calls
`realpath` / `fs.lstat`. An agent that creates `/tmp/decoy` as a symlink to
a protected file inside the project and writes to `/tmp/decoy` evades
detection — the absolute-traversal-touches-protected-root check compares
the raw absolute path against the project prefix and `/tmp/…` is outside.

**Fix**: Resolve symlinks via
`fs.realpathSync(path.resolve(projectRoot, targetPath))` before matching;
on EEXIST/EACCES, fail closed.

### D-07 🔴 `extern-alias` registry plumbed into trace-evaluator only (P0-6 incomplete)

**Where**: `packages/cli/src/commands/check-stages-trace.ts:180-185` vs
`packages/effect-evaluator/src/evaluator.ts:54-66` and
`packages/type-state-evaluator/src/`

P0-6 added the parser, uniqueness validator, and CLI wiring of
`externAliases` — but the registry is passed only into the trace-evaluator.
`EvaluateEffectOptions` and the type-state evaluator have no
`externAliases` field. A contract that uses `extern:logical-name::Foo` in
effect policies or type-state transitions will NOT have it resolved across
languages.

**Fix**: Plumb `externAliases?: ExternAliasRegistry` through
`evaluateEffects` and `evaluateTypeState`. Wire from the CLI stages the
same way `check-stages-trace.ts` already does.

### D-08 🔴 Lenient mode for `path_exceeded_max_depth` unreachable from CLI

**Where**: `packages/cli/src/commands/check-stages-trace.ts:182-186`

P0-5 added `strictMode?: boolean` to `EvaluateTraceOptions` (defaults
true), but the CLI calls `evaluate({ contract, callGraph, externAliases })`
without passing it and there is **no `--lenient-trace` / `--strict-trace`
CLI flag** anywhere. Either intentionally permanent (the contract author
chose to lock strict-mode) or a missing flag. Either way, docs/spec should
state it clearly.

**Fix**: Either remove the `strictMode` parameter entirely (it's dead
config) or expose a CLI flag and document it in `docs/spec/cdl.md`.

### D-09 🟡 P1-2 structural FIX_HINT check is defeated by content inversion

**Where**: `contract/checker_impls/self_protection.py:1208-1270`

`_analyze_fix_hint_structure` verifies anchors `[A] Code issue` then
`[B] Contract issue` exist in order, the A-region has ≥20 stripped chars,
the B-region contains `propose` and `contract/design/proposals`, and the
`Choose [A] or [B] before acting` tail. An adversary that writes

```
[A] Code issue — n/a, this is purely a contract problem; do not modify code.
[B] Contract issue — actually just patch the line directly … propose only if … contract/design/proposals/…
Choose [A] or [B] before acting
```

passes every gate but has the semantic roles swapped.

**Fix**: Require the A-region to contain at least one of a small whitelist
of action verbs like `fix`/`change`/`update`/`replace`/`edit` and the
B-region to contain `propose`. Pair with a content-symmetric negative test.

### D-10 🟡 P1-3 lenient-flag detector ignores Python / Node delegation

**Where**: `contract/checker_impls/self_protection.py:1060-1062`

`_SCRIPT_REF_RE` matches `bash|sh|zsh` and `.sh|.bash|.zsh` paths only. A
workflow step `- run: python scripts/myci.py` or
`- run: node tools/run.js` or `- run: pnpm run myci` (with
`--lenient-effects` in `package.json`'s script body) is not scanned. Same
with composite actions (`uses: ./.github/actions/x`) and Makefile
delegations.

**Fix**: Walk every file referenced as a path in `run:` lines regardless
of extension; also scan `package.json#scripts.*` and any locally
referenced composite action `action.yml`.

### D-11 🟡 P1-5 chain truncation produces an absurd "[... 1 more callees]" marker for chain length 6

**Where**: `packages/effect-evaluator/src/violation-builder.ts:88-120`

With `PROPAGATION_CHAIN_RENDER_CAP=5`, head=4 and tail=1, a length-6 chain
collapses exactly one middle node into a marker that's longer than the
node itself. Lengths 0 / 1 / 5 are correct; lengths 6+ have this
anti-feature only when the collapse count is 1.

**Fix**: When `collapsedCount === 1`, render the middle node verbatim
instead of the marker. Trivial guard.

### D-12 🟡 Conformance fixtures pin `cause.summary` exact text

**Where**: `tests/conformance/fixtures/08-phase-b-trace-must-transit/expected-violations.json:17`
and 09; comparator: `tests/conformance/comparators.ts:98`

`assertViolationReportsEqual` enforces
`actual.cause.summary === expected.cause.summary` with no toleration.
Coupling copywriting decisions to the spec — the opposite of the
fingerprint design which deliberately excludes free-text.

**Fix**: Either drop `cause.summary` from the comparator (it's already not
in the fingerprint) or accept a regex / substring match.

### D-13 🟡 Defense-in-depth lists for `protected` are triple-sourced

**Where**: `packages/cli/src/config/defaults.ts:36-58` +
`packages/core/src/config/defaults.ts:8-30` +
`packages/claude-code-plugin/scripts/pre-tool-protect.js:30-53`

Three separately-maintained "default protected" lists with subtly
different membership. A future P0/P1 fix that updates one will silently
drift the others.

**Fix**: Have all three import the same constant from `@stele/core` and
add a self-protection invariant that asserts byte-equal sets.

### D-14 🟢 `loadPreviousApprovedProfile` uses `require()` in an ESM module

**Where**: `packages/cli/src/commands/design/approve.ts:104,119`

The codebase is ESM-only (CLAUDE.md "ESM only"); `approve.ts` uses
`require("node:fs").readdirSync` and `require("node:child_process").execFileSync`.
Under strict ESM this throws at runtime when the fallback path triggers.

**Fix**: Use top-of-file ESM imports.

### D-15 🟢 `mergeCheckReports` runs cross-rule annotation twice

**Where**: `packages/trace-evaluator/src/evaluator.ts:375` +
`packages/cli/src/commands/check.ts:279`

Not a bug per se — the trace-evaluator still runs
`annotateCrossRuleViolations` internally before returning, then
`mergeCheckReports` re-annotates the union. P1-4 should have removed the
per-evaluator call once the merge-layer annotation was in place.

**Fix**: Delete the in-evaluator annotation; rely on merge-layer only.

## Verified healthy (no action needed)

- P0-5 trace-evaluator has exactly one `path_exceeded_max_depth` emission
  site wired through `strictMode`.
- P0-6 `extern-alias` parser + uniqueness validator + CLI registry
  construction (for trace) all correct.
- P0-7 No `--no-strict-effects` / `--no-strict-trace` references remain.
- P1-1 CI workflow ordering correct.
- P1-4 `annotateCrossRuleViolations` is cleanly in `@stele/core`,
  idempotent on identical input.
- P1-6 `effect_evidence.propagation_chain` is the FULL chain; excluded
  from `buildViolationFingerprint`'s payload so truncation cannot
  destabilize baselines.
- P1-7 fail-fast fixture runners.
- P1-8 spec changelog naming-history paragraph added.

## Summary table

| # | severity | one-line |
|---|---|---|
| D-01 | 🔴 | CLI loadConfig still REPLACES user-supplied `protected` (P0-3 only fixed plugin) |
| D-02 | 🔴 | `stele design approve` is rubber-stampable by an agent — P0-4 bypass |
| D-03 | 🔴 | `stele design init --generate` auto-passes `--force` — second P0-4 bypass |
| D-04 | 🔴 | conftest.py never registered the 3 new Phase B checkers → pytest fails with KeyError |
| D-05 | 🔴 | `ln -s`, `python -c`, `node -e`, `git checkout` etc. bypass pre-tool-protect |
| D-06 | 🔴 | `matchProtectedPath` doesn't realpath symlinks |
| D-07 | 🔴 | extern-alias registry plumbed into trace-evaluator only |
| D-08 | 🔴 | `strictMode` lenient branch is unreachable from the CLI |
| D-09 | 🟡 | P1-2 structural check passes a content-inverted A/B hint |
| D-10 | 🟡 | P1-3 lenient-flag detector misses .py / .js script delegation |
| D-11 | 🟡 | P1-5 chain truncation produces absurd "[... 1 more]" marker for length 6 |
| D-12 | 🟡 | Conformance comparator pins `cause.summary` text exactly |
| D-13 | 🟡 | Three separately-maintained "default protected" lists |
| D-14 | 🟢 | `approve.ts` uses `require()` in ESM-only project |
| D-15 | 🟢 | `annotateCrossRuleViolations` runs twice (trace stage + merge stage) |
