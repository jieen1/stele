# Contract coverage (`stele coverage`)

`stele coverage` answers a single question: **how much of the code that matters
is protected by a contract, and which high-churn modules are unprotected?**

It is read-only and fully static. Coverage is computed from the contract's own
target/scope patterns matched against the source tree — no tests run, no line
instrumentation. (Dynamic invariant-on-app-state line coverage is a separate
future extension.)

## The model

- **Denominator (the "countable universe"):** product source files under
  `packages/*/src/**` plus the Python runtime and checker implementations. Tests,
  build output, fixtures, examples, generated contracts, and `*.d.ts` are
  excluded.
- **Numerator:** for each declaration, the files its mechanism *binds*:
  - `boundary` / `class-shape` / `function-shape` / `type-policy` / `file-policy`
    expand their `target` glob.
  - `core-node` and `branded-id` resolve their `file::symbol` target.
  - `architecture` assigns files to modules via the module globs.
  - `trace-policy` / `effect-policy` / `type-state` match their target/scope
    patterns against the call graph and attribute coverage to the in-scope
    source files.
- **Zero-binding honesty gate:** a trace/effect/type-state declaration whose
  selector resolves to **zero** real call-graph nodes binds nothing and
  contributes **no** file coverage — it cannot paint a file green.
- **Non-spatial guards:** Python checkers and `uses-checker` invariants have no
  spatial expansion. They are counted under `nonSpatialGuards` and never mark a
  file covered.

## Usage

```bash
stele coverage                      # headline %, churn-ranked unprotected hotspots, per-package rollup
stele coverage --json               # deterministic CoverageReport JSON (no wall-clock)
stele coverage --min 80             # exit 2 (CONTRACT_FAIL) if overall coverage % < 80
stele coverage --top 20             # number of unprotected hotspots to list (default 10)
stele coverage --since main         # churn window (default: full history)
```

## Exit codes

- `0` — success (or `--min` met).
- `2` (`CONTRACT_FAIL`) — `--min` threshold not met.
- `5` (`CONFIG_ERROR`) — `stele.config.json` or the contract could not be loaded.

## Notes & limitations

- Symbol mechanisms (trace/effect/type-state) require a call-graph extractor.
  TypeScript and Python have one; on Go/Rust/Java they report
  `support: "unsupported"` and contribute 0.
- `extern:` targets contribute no file coverage (metadata only).
- Churn uses batched, no-follow commit counts (no rename tracking).
- Exemptions/suppressions narrow enforcement but do not reduce file coverage in
  v0.
