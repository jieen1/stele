# Trusted Computing Base (TCB) classification

Stele's entire value proposition is **a green check means real protection**. The
corollary: *any component whose bug could turn an authoritative `stele check` into a
false PASS (or let a protected write through, or release a failing Stop hook) is part
of the Trusted Computing Base.* New evaluators, backends, gates, and verdict-emitting
commands keep entering the TCB silently — the two CRITICAL incremental false-greens
of 2026-06-07 are the proof. This document makes the boundary an explicit, enforced
architectural fact.

Each component is classified:

- **verdict-bearing** — a bug can flip an authoritative result to a false PASS / silent
  allow. These are the TCB. They carry an **admission obligation** (below).
- **advisory** — a bug misleads, mis-decorates, or mis-measures, but *cannot mask a
  real contract violation*. Coverage maps, lint, score, explain, docs.

> Authority note: the only **authoritative** verdict is a full `stele check` (no
> `--changed`). The Stop hook (`stop-validate.js` → `args:["check"]`) and CI both run
> it. `stele check --changed` is **advisory by construction** (see
> [`cdl.md` §`stele check`](../spec/cdl.md)) and never gates anything — so even a bug
> in the incremental planner cannot produce a *trusted* false green.

Scope: the repo has **17 real workspace packages** (`packages/foo/` is a stray dir
with no `package.json`; CLAUDE.md's older "19"/"eight" counts are stale).

## Packages (16 verdict-bearing, 1 advisory)

| Package | Class | Why |
|---|---|---|
| `@stele/core` | verdict-bearing | lexer→…→generator + `verifyGenerated`/`verifyManifest`; a bug drops an invariant or passes drifted bytes |
| `@stele/backend-python` | verdict-bearing | Stele's own target language; generates the pytest source + runtime behind every uses-checker |
| `@stele/backend-{go,rust,java,typescript}` | verdict-bearing | generator bug → adopter's generated tests wrongly pass → false green downstream |
| `@stele/call-graph-core` | verdict-bearing | call-graph + `extern:` resolver feeding every Phase-B evaluator and the `--changed` planner; a dropped edge → zero violations found |
| `@stele/trace-evaluator` | verdict-bearing | drives the `trace` stage; a missed forbidden path → stage OK |
| `@stele/type-state-evaluator` | verdict-bearing | drives `type-state`; a missed wrong-state-at-binding → OK |
| `@stele/effect-evaluator` | verdict-bearing | drives `effect` incl. unresolved-call fail-closed gating; a missed effect → OK |
| `@stele/type-driven-evaluator` | verdict-bearing | drives `type-driven`/branded-id; a missed bare-string-where-brand-required → OK |
| `@stele/architecture-core` | verdict-bearing | import/dependency extraction for the `architecture` stage; an under-reported edge → rule wrongly OK |
| `@stele/cli` | verdict-bearing | owns the pipeline: `runAllStages`, exit codes 0/2/3, `mergeCheckReports`, the `--changed` planner. Highest blast radius (origin of both incremental false-greens) |
| `@stele/agent-hooks` | verdict-bearing | `matchProtectedPath` + pre-edit-protect + stop-validate SDK; a bug → protected write allowed / Stop released on failure |
| `@stele/claude-code-plugin` | verdict-bearing | the live fail-closed gate on this repo (`pre-tool-protect.js`, `stop-validate.js`) |
| `@stele/github-action` | verdict-bearing | CI wrapper with its own `failOn` filter + exit-3→`setFailed` mapping; could swallow a real error and pass the PR |
| `@stele/mcp-server` | advisory | spawns the CLI and surfaces results; not itself the enforced Stop/CI gate (borderline — flagged) |

## Commands (8 verdict-bearing)

**verdict-bearing:** `check` (the verdict command), `generate`, `lock`,
`baseline-init` / `baseline-update` (over-suppression → active violation counted
suppressed), `unlock`, `incident` (its `teeth` step is a gate — a drafted contract
must bite before `approve`), `design` (approval-gate / profile integrity).

**advisory:** `version`, `list`, `lint`, `rules`, `explain`, `why`, `agent-context`,
`add-checker`, `propose`, `maintenance-summary`, `observe`, `mcp`, `dev`, `doc`,
`score` (its `--threshold` exit 6 is a *separate* advisory gate), `coverage` (its
`--min` exit 2 is an advisory coverage gate independent of contract correctness),
`complexity`, `install`, `plugin`, `doctor`, `cache`.

**The TCB = 16 packages + 8 commands.** It is encoded as data in
[`tcb.json`](../../tcb.json). *Follow-up:* add `tcb.json` to the manifest's protected
set so demoting a module to advisory becomes a protected-file edit that cannot be done
quietly — for now the admission-gate test (below) catches drift.

## Admission rule

> **Every verdict-bearing module MUST be referenced by at least one NEGATIVE test** —
> a test that constructs a should-fail input and asserts the module emits a violation /
> non-ok report / blocking exit (2 or 3) / hook deny.

The 143-test negative suite (`contract/checker_impls/test_negative.py`) is this tax
for the *checker* layer. The admission rule extends it to the whole TCB.

### Coverage signal (what counts)

A verdict-bearing module id is **covered** when a test carries a
`@tcb-negative <module-id>` tag **and** a fail-shape assertion in the same block:

- TS: `.ok).toBe(false)` · `toThrow` · `exitCode).toBe(2|3)` · a non-empty
  `violations` assertion · a `deny`/`block` decision assertion.
- Python: the existing `test_negative.py` tamper-and-assert-bite pattern.

### Enforcement

`packages/cli/tests/tcb-admission.test.ts` (runs in `pnpm test` / CI) reads
`tcb.json`, scans the whole test corpus for `@tcb-negative` tags + fail-shapes, and
fails if (a) any verdict-bearing entry has zero covering tests, or (b) a tag names an
id absent from `tcb.json` (orphan tag — two-way binding). This is the cheap static
gate; a future promotion to a `uses-checker` (`sp_tcb_negative_coverage.py`) plus a
nightly mutation probe (mutate the named module's verdict line, confirm the tagged
test fails) is the high-assurance backstop — tracked, not yet shipped.

### The rule in one line

*No verdict-bearing change merges without a negative test, and the verdict boundary
itself is checked-in, protected data.*
