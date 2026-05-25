# Closeout 5 — Eliminate the trace depth-cap error properly

**Goal:** Eliminate `trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth`
by investigating the underlying call path, narrowing the policy
scope to a defensible boundary, AND adding partial-path memoization
to the trace evaluator so depth caps stop discarding work.

**Why:** The policy targets `extern:node-fs::writeFile(*)` and the
evaluator walks back through every caller. One path from
`loadContract` → ... → `writeFile` exceeds the analyzer's default
maxDepth. The convenient response is "bump maxDepth"; that is
forbidden by CC-12-ish reasoning (don't paper over an analyzer
limit). The principled response is:

1. Investigate the path to confirm whether it genuinely violates the
   policy or is a false positive.
2. If false positive (e.g. `loadContract` writes only to its
   `.cache/` and the call is through a legitimate non-`writeAtomic`
   path the policy never meant to cover), narrow the policy's
   `(scope …)` or add a targeted `(exempt …)` with rationale.
3. If genuine, fix the source (route the write through
   `writeAtomic`).
4. As a separate improvement, add partial-path memoization to the
   trace evaluator so future analyses scale better.

**Out of scope:**
- Bumping `maxDepth` as the primary fix (forbidden — see anti-pattern
  #9 in README)
- Disabling the policy
- Marking the trace stage as advisory

## Steps

### Step 5.1 — Reproduce + investigate the path

Run `stele check` with verbose tracing if the evaluator supports it,
or instrument `packages/trace-evaluator/src/` temporarily to dump the
truncated path. Identify EVERY caller chain from `loadContract` to
the unresolved `writeFile` site.

Document the chain in
`docs/design/self-dogfooding-closeout/closeout-5-trace-path.md` (a
work-in-progress doc the sub-agent commits as evidence).

### Step 5.2 — Decide the right fix

Three cases. **Cases (A) and (B) require explicit anti-loophole
gates before the sub-agent may proceed; case (C) is preferred when
applicable.**

- **(A) Genuine false positive — the truncated chain provably
  does NOT reach `writeFile` outside `writeAtomic`.** The depth cap
  is hiding the evaluator's legitimate "no violation" conclusion.
  - **Gate (A1):** the sub-agent MUST first produce a non-memoized,
    unbounded exhaustive walk of the chain (set `maxDepth: Infinity`
    in a one-shot diagnostic harness, NOT in the shipped evaluator)
    and capture the FULL set of terminal nodes reachable from the
    truncated branch. Dump them to
    `docs/design/self-dogfooding-closeout/closeout-5-exhaustive-walk.md`.
  - **Gate (A2):** every terminal in the dump must be either
    `writeAtomic`-routed OR explicitly outside `(scope ...)`. If any
    terminal is a direct `writeFile` outside `writeAtomic`, case (A)
    is rejected — fall through to case (C).
  - Only after (A1) + (A2) pass: add partial-path memoization
    (step 5.4). Memoization is the perf-improvement; the SAFETY
    proof comes from the exhaustive walk, not from memoization.
- **(B) False positive due to over-broad scope.** The scope catches
  a NodeId that the policy never meant to protect.
  - **Gate (B1):** the sub-agent MUST enumerate, by NodeId, every
    site that would be excluded by the narrower scope, and prove for
    each — in the closeout-5 commit message — why that site is
    provably acceptable to exclude. "It writes to .cache, not the
    manifest" is not a proof; the proof must show the call does not
    flow into any path the policy is meant to cover, by the same
    exhaustive-walk standard as gate (A1).
  - **Gate (B2):** the sub-agent MUST escalate to the main agent
    BEFORE narrowing scope. The main agent reviews the per-NodeId
    proofs and approves. No silent narrowing.
  - Only after (B1) + (B2) pass: update `(scope ...)` via
    propose/approve.
- **(C) True positive — there is a real `writeFile` call inside
  `@stele/core/src/**` that does NOT route through `writeAtomic`.**
  → Fix the source. Route the write through `writeAtomic`. No
  gates; this is the principled fix.

The investigation in 5.1 reveals which case applies. The sub-agent's
commit message must state which case was chosen, summarize the gate
evidence, and (for A/B) link to the exhaustive-walk dump.

### Step 5.3 — Apply the chosen fix

For (A) or (B): touch only `contract/main.stele` (or the
`tsconfig`/scope settings) and the trace-evaluator as needed.

For (C): write a focused fix commit. Source change must NOT be
"silence-the-symptom" — the new code routes through `writeAtomic`
and inherits its atomicity guarantee.

### Step 5.4 — Add partial-path memoization (improvement, not the fix)

In `packages/trace-evaluator/src/`, add a memoization layer so that
when a node has been fully walked and proven to (not) reach the
target, the result is cached for the duration of the evaluator run.

Cache key: `(currentNode, target, exemptSet, sourceConstraint)`.

This is an evaluator-level improvement; it MUST be unit-tested in
`packages/trace-evaluator/tests/`:

1. **Memoization correctness.** Same input twice produces same
   result; cache hits do not change the violation list.
2. **Cache invalidation across evaluator runs.** Two consecutive
   `evaluateTracePolicies` calls produce identical results; cache
   does not leak.
3. **Deep path no longer hits depth cap.** A synthetic graph with a
   chain of 50 nodes where the target sits at depth 30 produces 0
   violations (or 1, depending on test design) and 0 depth-cap
   errors.

### Step 5.5 — Removal of any stale "depth cap" workarounds

Any prior `(exempt …)` or `(scope …)` lines added specifically to
work around the depth cap (rather than expressing real semantic
boundaries) are reviewed and removed. The sub-agent grep:

```
rg "depth|maxDepth|exempt.*depth" contract/main.stele
```

Any hit must be either a semantic exemption (writeAtomic is
exempt because it IS the atomic wrapper) or removed.

### Step 5.6 — CC-13 negative tests

The FS_WRITES_VIA_WRITE_ATOMIC policy already has 1 paired test
(`test_fs_writes_via_write_atomic_catches_direct_writeFile`). Per
CC-13, add a second:

`test_fs_writes_via_write_atomic_catches_deep_chain`. Introduce a
3-level call chain ending in a direct `writeFile` (not through
`writeAtomic`); assert the trace-policy fires. This specifically
exercises the partial-path memoization at non-trivial depth.

### Step 5.7 — Update predecessor decision-log

Append `RESOLVED in commit <closeout-5 final SHA>` to the Phase 5
decision-log entries that mention
`trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth` (and the
Phase 7 follow-up `#1` in the Q2 summary).

### Step 5.8 — CC-3

```
pnpm build && pnpm typecheck
node packages/cli/dist/index.js lock
node packages/cli/dist/index.js check     # 0 errors, including the previous depth-cap one
.venv/bin/pytest tests/contract -q
.venv/bin/pytest contract/checker_impls/test_negative.py -q
.venv/bin/pytest packages/trace-evaluator/tests/ -q   # new memoization tests pass
```

## Acceptance criteria

- [ ] `stele check` no longer reports
      `trace.FS_WRITES_VIA_WRITE_ATOMIC.path_exceeded_max_depth`
- [ ] The chosen fix (A / B / C) is documented in the commit message
- [ ] If (B): the new scope is defensible and recorded in the
      decision log
- [ ] Trace evaluator has partial-path memoization with 3+ unit tests
- [ ] FS_WRITES_VIA_WRITE_ATOMIC has 2 paired negative tests, one
      exercising deep chains
- [ ] `maxDepth` default is unchanged
- [ ] Predecessor decision-log appended with RESOLVED line

## Sub-agent execution prompt

```
Read README.md (forbidden anti-pattern list, especially #9: don't
bump thresholds) and closeout-5-trace-depth-cap.md.

Execute steps 5.1 → 5.8.

Forbidden:
- Bumping `maxDepth` (or any analyzer budget) as the primary fix
- Marking the policy `severity: warning`
- Adding `(exempt ...)` that doesn't express a real semantic
  boundary (CC-12 — silence vs fix)
- Skipping the memoization step "to keep the change small"

Land in 3-5 commits: 1 investigation doc, 1-2 evaluator memoization
(+ unit tests), 1 contract fix if case B applied, 1 negative test
+ re-lock.

DO NOT push.
```
