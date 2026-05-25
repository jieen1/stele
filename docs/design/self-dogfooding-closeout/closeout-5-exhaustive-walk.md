# Closeout 5 — exhaustive call-graph walk dump

**Generated:** 2026-05-25T08:59:05.075Z
**Script:** scripts/diagnostics/exhaustive-walk-loadcontract.mjs
**Caller:** `packages/core/src/loader/load-contract.ts::loadContract(1)`
**Target pattern:** `extern:node-fs::writeFile(*)`
**Scope pattern:** `packages/core/src/**/*.ts` (caller filter — the caller above IS in scope)
**writeAtomic NodeId:** `packages/core/src/manifest/hash-manifest.ts::writeAtomic(2)`

## Call graph stats

- Nodes: 9691
- Edges: 42502

## Enumeration parameters

- `maxDepth` = nodes+1 = 9692 (functionally unbounded for simple paths)
- `maxPaths` = 100000
- Elapsed: 15ms
- Paths found: 0
- Truncated: false

## Target NodeIds matched

- `extern:node-fs::writeFile(2)`
- `extern:node-fs::writeFile(3)`

## Gate (A2) verdict — per terminal

For each terminal NodeId reachable from `loadContract` matching the target pattern, every simple path must either transit `writeAtomic` OR be outside the scope. Otherwise case (A) is REJECTED.

## Reproducing the production failure with default maxDepth=10

- Paths found: 0
- Truncated: true

With `maxDepth=10` (the shipped default), the DFS from `loadContract` hits the depth cap before completing — the evaluator therefore can NOT prove the negative ("no violation") and emits `path_exceeded_max_depth`. With `maxDepth=9692` (unbounded for any simple path), the walk completes and finds zero paths to the target.

## BFS depth distribution from `loadContract` (reachable subgraph)

Total reachable nodes: 104. Max BFS depth reached: 8.

| depth | nodes |
|---|---|
| 0 | 1 |
| 1 | 6 |
| 2 | 19 |
| 3 | 17 |
| 4 | 10 |
| 5 | 27 |
| 6 | 17 |
| 7 | 5 |
| 8 | 2 |

BFS depth = shortest distance from caller; the trace evaluator uses simple-path DFS, which can visit any node through arbitrarily long non-repeating chains. Even with max BFS depth = 8, the reachable subgraph of 104 nodes admits simple paths longer than 10 — that is what trips the cap.

## What the shipped DFS sees at each maxDepth budget

| maxDepth | paths found | depth-cap hit |
|---|---|---|
| 10 | 0 | true |
| 12 | 0 | false |
| 15 | 0 | false |
| 20 | 0 | false |
| 30 | 0 | false |
| 50 | 0 | false |
| 100 | 0 | false |
| 9692 (unbounded) | 0 | false |

Paths found stays at 0 for all budgets — the target is genuinely unreachable from the caller. The depth-cap-hit column flips to false only once the budget exceeds the longest simple path in the reachable subgraph (well above the shipped 10). The closeout's partial-path memoization lets the DFS skip re-walking nodes already proven not-to-reach-target during the same evaluator run, so the same evidence is produced without altering the depth cap.

## Overall verdict

**Case (A) ACCEPTED.** `loadContract` does not transitively reach any `extern:node-fs::writeFile(*)` site at all — neither directly nor through `writeAtomic` — so Gate (A2) is trivially satisfied (no terminal exists). The shipped depth cap is hiding a legitimate "no violation" conclusion: DFS times out exploring long compositional chains in the reachable subgraph before it can establish that none of them lead to `writeFile`. The principled fix is partial-path memoization, which preserves analyzer semantics and the cap value (`maxDepth=10` stays) while letting per-run negative results short-circuit re-exploration.
