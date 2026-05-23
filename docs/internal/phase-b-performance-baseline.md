# Phase B Performance Baseline (T6.2)

**Date**: 2026-05-23
**Spec**: FINAL-SPEC §D-B-007
**Scope**: `stele check` with Phase B mechanisms (trace + type-state + effect) wired into the check stage registry.

This is a snapshot baseline, not a target. It is meant to be re-runnable so future
regressions or improvements can be compared apples-to-apples via
`scripts/benchmark-phase-b.mjs`.

## Hardware & toolchain

```
$ uname -a
Linux DESKTOP-LN6MHG4 6.6.114.1-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC \
  Mon Dec  1 20:46:23 UTC 2025 x86_64 x86_64 x86_64 GNU/Linux

$ node --version
v22.22.0

$ pnpm --version
9.15.0
```

WSL2 on commodity laptop hardware. No special tuning. Runs are single-threaded
(spawning `node packages/cli/dist/index.js check` once per measurement).

## Budget (FINAL-SPEC §D-B-007)

| Project size | Budget |
|---|---|
| Medium (~1000 files) | < 60 s |
| Large (~10 000 files) | < 5 min |
| Incremental | < 20 s |

## Results

Measured by `scripts/benchmark-phase-b.mjs` — cold run is a fresh `node` process
with no in-process caches; warm run is the same command issued immediately
after, exercising OS page-cache only (the engine itself has no in-memory cache
across CLI invocations).

| Project | Files (approx) | Cold (ms) | Warm (ms) | Exit | Budget |
|---|---:|---:|---:|---:|---|
| `examples/finance-guard` | 15 | 282 | 272 | 2 (drift) | n/a (toy) |
| stele repo (`.`) | 1 215 | 8 492 | 8 232 | 0 | medium (< 60 s) |
| synthetic 1k (10× finance-guard) | 1 036 | 276 | 271 | 2 (drift) | medium (< 60 s) |

Three additional repeated runs against the stele repo for variance:

| Run | Cold (ms) | Warm (ms) |
|---:|---:|---:|
| 1 | 8 290 | 8 457 |
| 2 | 8 173 | 8 738 |
| 3 | 8 355 | 8 196 |

Standard deviation across the cold runs is roughly 130 ms (< 2%). Cold ≈ warm
because no in-process cache survives across CLI invocations.

Peak RSS: ~880 MB for the stele repo run, ~140 MB for the toy projects. The
bulk of memory growth correlates with TypeScript source enumeration, not CDL
parsing.

## Notes on each measurement

### `examples/finance-guard`
Returns exit code 2 (`stele.check.generated_drift`) — the in-repo fixture has
pre-existing generated drift. The number recorded is the wall-clock until the
drift error is emitted, not a clean check. Honest baseline; this fixture was
not "fixed" for the benchmark.

### Stele repo itself (the most realistic medium-sized run we have)
Exit 0, all 31 invariants pass, 3 generated files and 11 protected files
verified. ~1 215 source files traversed. This is **≈ 8.5 s cold vs. a 60 s
medium budget** — comfortable headroom (~7×).

### Synthetic 10× amplification
Duplicating `examples/finance-guard/app/` and `tests/` to ~1 000 files did
*not* meaningfully change runtime (276 ms cold vs. the 282 ms baseline). This
is an honest finding, not a measurement artifact:

> `stele check` validates the **contract manifest** plus the protected/generated
> trees enumerated in `stele.config.json`. Inert duplicated files outside those
> trees are not touched. The synthetic dataset therefore does not exercise the
> engine differently from the un-amplified fixture.

Translating this to "what does it take to grow runtime"? It takes **more
invariants**, **more protected files**, and **more generated test code**, not
just more files in the directory tree. The stele repo run (31 invariants, 14
manifest-tracked files) is the closer proxy for medium-project load today.

### Incremental
Not separately measured. The current pipeline has no incremental mode — every
check re-parses the contract and re-hashes the manifest entries. Warm runs
match cold runs within noise. Adding a real incremental mode is part of the
larger Phase B follow-up; until it lands, the < 20 s incremental budget is
trivially satisfied by the cold-run number.

## Bottleneck observation (informal)

Without instrumentation we can only say where time is *not* spent: CDL parse +
validate is sub-100 ms (visible in the toy 282 ms run, the bulk of which is
`node` startup and module loading). The remaining ~8 s on the stele repo comes
from:

1. **TypeScript source enumeration + reading** for the protected-glob check and
   the Phase B extractors (trace / type-state / effect each walk the source).
2. **SHA-256 manifest verification** for ~14 tracked entries.
3. **Generated-file diff** for the pytest output tree.

Per-stage breakdown is not currently emitted by the CLI. Adding a
`STELE_PROFILE=1` knob that prints stage timings would be the next step if the
budget ever tightens; for now the headroom is too large to justify it.

## Comparison to budget

| Metric | Measured | Budget | Headroom |
|---|---:|---:|---:|
| Medium cold (1k files) | 8.5 s | 60 s | 7.1× |
| Medium warm (1k files) | 8.2 s | 60 s | 7.3× |
| Incremental (≈ warm) | 8.2 s | 20 s | 2.4× |
| Large (10k files) | not measured | 5 min | — |

The 10 000-file run is **not** measured here. The synthetic-amplification
attempt above shows that the engine does not scale on directory size — it
scales on the number of manifest entries / invariants / generated outputs.
A faithful large-project benchmark requires a contract with ~300 invariants
and ~150 protected files, which we do not yet have. That measurement is
deferred to a later phase.

## Reproduce

```bash
pnpm build
node scripts/benchmark-phase-b.mjs examples/finance-guard /tmp/bench-finance.json
node scripts/benchmark-phase-b.mjs . /tmp/bench-self.json
```

## Raw output

### `examples/finance-guard`

```json
{
  "schema_version": "1",
  "measured_at": "2026-05-23T09:47:11.754Z",
  "project_dir": "/home/bot/project/stele/examples/finance-guard",
  "cli_entry": "/home/bot/project/stele/packages/cli/dist/index.js",
  "node_version": "v22.22.0",
  "platform": "linux x64",
  "approx_file_count": 15,
  "budget": { "medium_ms": 60000, "large_ms": 300000, "incremental_ms": 20000 },
  "runs": [
    {
      "label": "cold",
      "exitCode": 2,
      "elapsedMs": 282,
      "peakRssMb": 139.2,
      "stderr_tail": "[error] stele.check.generated_drift ..."
    },
    {
      "label": "warm",
      "exitCode": 2,
      "elapsedMs": 272,
      "peakRssMb": 139.5,
      "stderr_tail": "[error] stele.check.generated_drift ..."
    }
  ]
}
```

### Stele repo (`.`)

```json
{
  "schema_version": "1",
  "measured_at": "2026-05-23T09:47:15.853Z",
  "project_dir": "/home/bot/project/stele",
  "cli_entry": "/home/bot/project/stele/packages/cli/dist/index.js",
  "node_version": "v22.22.0",
  "platform": "linux x64",
  "approx_file_count": 1215,
  "budget": { "medium_ms": 60000, "large_ms": 300000, "incremental_ms": 20000 },
  "runs": [
    {
      "label": "cold",
      "exitCode": 0,
      "elapsedMs": 8492,
      "peakRssMb": 880.4,
      "stdout": "OK 31 invariants checked; 3 generated files and 11 protected files verified."
    },
    {
      "label": "warm",
      "exitCode": 0,
      "elapsedMs": 8232,
      "peakRssMb": 879.6,
      "stdout": "OK 31 invariants checked; 3 generated files and 11 protected files verified."
    }
  ]
}
```

### Synthetic 10× finance-guard (1 036 files)

```json
{
  "approx_file_count": 1036,
  "runs": [
    { "label": "cold", "exitCode": 2, "elapsedMs": 276, "peakRssMb": 139.3 },
    { "label": "warm", "exitCode": 2, "elapsedMs": 271, "peakRssMb": 140.2 }
  ]
}
```
