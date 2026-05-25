# Closeout 2 — TS extractor learns `.js`; HOOK_NO_NETWORK re-activated

**Goal:** Enable `.js / .cjs / .mjs` files in the TypeScript
call-graph extractor so that hook scripts (which ship as plain ESM
`.js`) enter the call graph and the `HOOK_NO_NETWORK` effect-policy
can finally fire on them.

**Why:** `packages/backend-typescript/src/extractors/call-graph.ts:222`
sets `allowJs: false` and line 269 of the directory walker only
collects `.ts/.tsx`. The result: every hook script under
`packages/claude-code-plugin/scripts/*.js` is invisible to the
extractor. `HOOK_NO_NETWORK` (target-scope
`packages/claude-code-plugin/scripts/*.js::*`) targets nodes that
do not exist in the graph; it is dead by construction. Round 15
caught this; Closeout 2 fixes the root cause.

After this closeout:

- The TS call-graph extractor includes `.js / .cjs / .mjs` files.
- All hook scripts (pre-tool-protect, stop-validate,
  observation-hook, lifecycle-context, plus their shared helpers)
  have NodeIds in the graph.
- `HOOK_NO_NETWORK` policy fires on at least one synthetic test
  case AND would fire on any real hook that calls `fetch(...)` /
  `https.request(...)` / similar.
- The `@pytest.mark.skip` on
  `test_hook_no_network_catches_fetch_in_hook_script` is REMOVED.
  The test uses `assert` and passes.

**Out of scope:**
- Migrating hook scripts to TypeScript (option (b) in the original
  Phase 7 follow-up — we are taking option (a) because it is the
  more principled fix; .js source files exist in the wild and a
  TS-only extractor would miss them in adopter projects too).
- Type-checking the .js files (allowJs ≠ checkJs).
- Touching the Python or Go extractors.

## Required changes

### A. Extractor compiler options

**File:** `packages/backend-typescript/src/extractors/call-graph.ts`

Change `allowJs: false` (line 222) to `allowJs: true`. Add
`checkJs: false` explicitly so the change is non-breaking for
type-checking semantics (we want the AST and the call edges, not
the type errors).

### B. Directory walker

Same file, line 269: extend the file-extension predicate so
`collectTsFiles` returns `.ts`, `.tsx`, `.js`, `.cjs`, and `.mjs`
files. Continue excluding `.d.ts`, `.d.mts`, `.d.cts`. Continue to
skip `node_modules`, `dist`, `.git`.

Rename `collectTsFiles` → `collectJsTsFiles` for accuracy. Update
its call site at line 239. (CC-4: no alias — rename it.)

### C. NodeId builder + extractor type/AST handling

Verify the extractor's AST-walk code already handles JS-only syntax
(no JSX-vs-TSX confusion, no implicit-any cascade). The TypeScript
compiler API handles `.js` files natively when `allowJs` is true —
the extractor should not need source changes here, but **must be
unit-tested** to confirm.

### D. Perf gating

**Required:** measure `stele check` wall-clock before and after the
extractor change. The plan's risk register (lines 270-271 of the
predecessor README.md) put the budget at 30s cumulative for Phase B
stages. Closeout 2 must record before/after numbers in its commit
message.

If wall-clock grows by more than 5s, sub-agent must NOT silently
ship. **The sub-agent MUST escalate to the main agent before
choosing a perf workaround.** Options the main agent may approve:

1. **Cache the extracted graph more aggressively** — preferred fix.
   No correctness compromise; reuses existing
   `check-stages-call-graph-cache.ts` plumbing.
2. **Use a TypeScript LanguageService instead of a full Program** —
   bigger change; main agent decides whether to spin into a
   separate plan.
3. **Narrow the directory walker to specific subtrees** — **only
   permitted with an approved propose document** that enumerates
   every excluded subtree AND proves no policy-relevant `.js` file
   exists (or could exist) inside it. Hard-coding "only walk
   `packages/claude-code-plugin/scripts/`" is the
   anti-pattern #4 (allow-list bypassing evaluation) and is
   forbidden without that proof. The whole point of closeout 2 is
   that future hook scripts and `.js` adopters are covered too — a
   narrowed walker silently fails them.

Default expectation: option 1 closes the perf gap. Options 2 and 3
require explicit main-agent approval.

## Steps

### Step 2.1 — Baseline measurement

```
time node packages/cli/dist/index.js check     # 3 runs, median wall-clock
```

Record the baseline in the closeout commit message.

### Step 2.2 — Extractor change

Apply the changes from sections A, B, C. Build + typecheck.

### Step 2.3 — Unit tests

Add to `packages/backend-typescript/tests/`:

1. **JS files appear in extracted nodes.** Feed the extractor a
   fixture with one `.js`, one `.ts`, one `.mjs`, one `.d.ts`. Assert
   `.js`, `.ts`, `.mjs` produce nodes; `.d.ts` does not.
2. **JS-side call edges resolve correctly.** A `.js` file calling
   a function exported from a `.ts` sibling produces a resolved edge
   (not unresolved). Inversely a `.ts` calling a `.js` export.
3. **NodeId convention is stable across language.** A function named
   `foo` exported from `lib.js` produces NodeId `<rel-path>::foo(N)`
   identically to the TS case. (Prevents node-id drift breaking
   existing trace/effect contract bindings.)

### Step 2.4 — `HOOK_NO_NETWORK` becomes live

Remove the `@pytest.mark.skip` from
`test_hook_no_network_catches_fetch_in_hook_script` in
`contract/checker_impls/test_negative.py`. The test body already
drops a `.js` file with `@stele:effects network` and a `fetch(...)`
call. After Closeout 2 it must pass.

Per CC-13, add a **second** paired negative test:

`test_hook_no_network_catches_https_request`. Drop a different
sibling `.js` file that imports `node:https` and calls
`https.request(...)`. Assert
`effect.HOOK_NO_NETWORK.forbidden_effect` fires. (Different shape of
network call; prevents pass-by-vacuity if the analyzer only handles
the literal `fetch` identifier.)

### Step 2.5 — Re-measure perf

```
time node packages/cli/dist/index.js check     # 3 runs, median
```

Record before/after deltas in the commit message. If delta > 5s,
follow the perf-gating clause above.

### Step 2.6 — Sweep the call graph for newly-bound contracts

`stele check` may surface new violations now that `.js` files are
in the graph (e.g. effect-policy on the plugin scripts). The
contracts are correct. Either fix the source (CC-12 path A — real
violation in the .js file) or refine the contract via
propose/approve (CC-12 path B — contract is wrong).

**Forbidden:** do not narrow the policy scope to exclude new
findings unless an approved propose explains why each excluded site
is provably acceptable.

### Step 2.7 — Update predecessor decision-log

Append `RESOLVED in commit <closeout-2 final SHA>` to the
"HOOK_NO_NETWORK policy is dead by construction" entry in
`docs/design/self-dogfooding/README.md`.

### Step 2.8 — Re-lock + CC-3

```
pnpm build
pnpm typecheck
node packages/cli/dist/index.js lock
node packages/cli/dist/index.js check
.venv/bin/pytest tests/contract -q
.venv/bin/pytest contract/checker_impls/test_negative.py -q
.venv/bin/pytest packages/backend-typescript/tests/ -q
```

Negative test count should be 88 passed + 1 skipped (the
GENERATOR_NO_NETWORK skip remains until closeout 6).

## Acceptance criteria

- [ ] `allowJs: true`, `checkJs: false` in the extractor
- [ ] Directory walker collects `.ts/.tsx/.js/.cjs/.mjs`, excludes
  `.d.ts/.d.mts/.d.cts`
- [ ] `collectTsFiles` renamed to `collectJsTsFiles` (CC-4)
- [ ] 3+ new unit tests in `packages/backend-typescript/tests/`
- [ ] `test_hook_no_network_catches_fetch_in_hook_script` is
  no longer `@pytest.mark.skip`, uses `assert`, and passes
- [ ] `test_hook_no_network_catches_https_request` added and passes
- [ ] `stele check` exit 0 with no new noise (any new findings are
  either fixed in source or covered by an approved propose)
- [ ] Wall-clock delta documented in commit message; if > 5s, the
  perf-gating clause was applied
- [ ] Predecessor decision-log appended with RESOLVED line
- [ ] CC-3 green

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding-closeout/README.md (forbidden
anti-pattern list!) and
docs/design/self-dogfooding-closeout/closeout-2-allowjs-extractor.md.

Execute steps 2.1 → 2.8 in order. Land in 2-3 commits.

Forbidden moves (READ the README list):
- Marking any test @pytest.mark.skip (the goal is to UN-skip the
  hook-no-network test, not skip anything new)
- Narrowing HOOK_NO_NETWORK's target-scope to silence new findings
- Hard-coding an allow-list of "OK" .js files
- Adding a config flag to opt out of .js extraction
- Editing source in packages/claude-code-plugin/scripts/ to make
  a CDL contract pass

If `stele check` surfaces NEW unresolved-call or effect-policy
errors after the extractor change, STOP and report. They are real
violations that closeout 1 (already landed) intentionally surfaces.

Perf gating: if `stele check` wall-clock grows by >5s, do not ship.
Apply the perf-gating clause in the doc OR escalate to the main
agent.

DO NOT push. The main agent reviews + pushes.
```
