# Closeout 7 — Independent reviewer rounds until two consecutive clean rounds

**Goal:** Run independent reviewer sub-agents (Round 17, 18, …)
until **two consecutive** rounds return zero HIGH/MED substantive
findings. Then write the final wrap-up.

**Why:** CC-10 says the plan is not done until at least one
independent reviewer round returns zero substantive findings. After
6 closeouts that touched evaluators, contracts, configs, and
production source, the diff is large and the regression surface is
non-trivial. One clean round is necessary but not sufficient; two
consecutive demonstrate stability.

**Out of scope:**
- New contract work
- Performance tuning beyond what reviewer findings demand

## Steps

### Step 7.1 — Round 17: Comprehensive audit

Reviewer prompt (sub-agent):

```
You are Round 17 Reviewer — an INDEPENDENT auditor. You have NOT
participated in the closeout work. Treat this as a fresh audit.

Scope: every commit on `main` between
`docs/design/self-dogfooding-closeout/README.md`'s first commit and
HEAD. That covers the 6 closeouts that closed the 7 gaps from the
predecessor plan.

Read for context:
- docs/design/self-dogfooding-closeout/README.md (the 10-item
  forbidden anti-pattern list)
- docs/design/self-dogfooding/README.md (predecessor decision log)
- docs/internal/self-dogfooding-2026-Q2.md

Look for:
1. **Forbidden anti-pattern matches.** For each of the 10 forbidden
   moves in the closeout README, grep / read for matches in the
   new commits. Any match is a HIGH finding.
2. **Evaluator changes don't break existing contracts.** Each of
   the 4 active effect-policies, 4 trace-policies, 4 type-states,
   10 class-shapes still binds and still fires on its paired
   negative tests.
3. **`effectStrictMode` is truly gone.** grep across the repo.
4. **HOOK_NO_NETWORK is truly live.** The test is no longer skipped
   and assertion-fails if you remove the policy.
5. **9 aggregate class-shapes really bind to real source.** Mutate
   one source method per aggregate and assert the contract fires.
6. **Type-state evaluator binds >0 sites per lifecycle.**
7. **Trace depth-cap is gone.** No `path_exceeded_max_depth`
   anywhere in `stele check` output.
8. **5 deferred contracts are live.** Each has 2 paired tests; each
   binds.
9. **Decision-log RESOLVED accounting.** Every "Phase 7 follow-up"
   or "deferred" entry in the predecessor README.md has a RESOLVED
   line.
10. **Test count math.** Original 88 (vacuous) → after Round 15:
    86 + 2 skip. Closeouts 1, 2, 3b, 4, 5, 6 should net-add ~32 new
    negative tests. Real count and shape should match expectations.

Up to 12 findings. HIGH for anti-pattern matches or for real
regressions. MED for documentation drift or missed test coverage.
LOW for nits. **READ-ONLY: no edits, no commits, no push, no
sub-agents.**
```

### Step 7.2 — Fix Round 17 findings

Each HIGH and MED finding gets a focused fix commit + (if it
touched contracts/evaluators) paired negative tests + re-lock.

LOW findings: bundle into one cleanup commit at the end. Skip LOW
findings only if the user-approved decision log explicitly says
"won't fix" with rationale.

### Step 7.3 — Round 18: BROAD audit (same scope as Round 17) PLUS regression hunt

**Convergence rule (M4 anti-gaming fix):** both consecutive clean
rounds must use the SAME broad scope as Round 17 — the entire diff
since the closeout README's first commit. A narrow "regression
hunt only" round does NOT count toward convergence even if clean,
because auditing strictly less than the prior round is structurally
weaker.

Reviewer prompt:

```
You are Round 18 — independent auditor. Audit BOTH:

(1) the entire commit range since
docs/design/self-dogfooding-closeout/README.md's first commit
(same scope as Round 17), and

(2) specifically the fix commits Round 17 produced — confirm those
fixes don't themselves match any of the 10 forbidden anti-patterns
and don't introduce new gaps.

You are NOT permitted to audit (2) without also doing (1). A
"regression-only" clean round does not count toward convergence.

Same READ-ONLY rules: no edits, no commits, no sub-agents.
```

### Step 7.4 — Repeat until convergence

If Round 18 finds anything HIGH/MED → fix, then Round 19 (same
broad scope as 17 + 18). Continue until **two consecutive broad-
scope rounds** return zero HIGH/MED. LOW findings within those two
rounds do not block convergence but must be captured in the final
wrap-up doc as "known low-priority" with rationale.

### Step 7.5 — Update wrap-up doc

The predecessor wrap-up doc `docs/internal/self-dogfooding-2026-Q2.md`
already exists. **Update it in place** (append a new section
"Closeout 2026-Q2" with the contents below); do NOT branch into a
new file. The Q2 summary is the canonical reading-order entry #2
for future maintainers; one doc, one truth.

Section contents:
- The 7 gaps and their closing commits
- Final invariant / negative-test / contract / class-shape counts
- The N reviewer rounds that ran + final outcome
- "Known LOW-priority items" list (anything in the final two clean
  rounds that was LOW + not fixed, with rationale)
- Pointers to the closeout plan dir

### Step 7.6 — Final commit + push

Single commit per the predecessor's Step 7.8 pattern. The user
pushes; sub-agents do not.

```
node packages/cli/dist/index.js check     # exit 0
node packages/cli/dist/index.js list | wc -l   # final invariant count
git push origin main      # main agent only
```

## Acceptance criteria

- [ ] Two consecutive reviewer rounds return zero HIGH/MED findings
- [ ] Final wrap-up doc written
- [ ] `stele check` exit 0 with zero errors
- [ ] All decision-log entries in the predecessor README.md have
      RESOLVED lines

## Sub-agent execution prompts

The reviewer prompts are inlined in steps 7.1 and 7.3.

For step 7.2 / 7.4 fix dispatches, use the same per-closeout sub-agent
pattern: one prompt, one focused fix, CC-3 green, return SHAs.

DO NOT push.
