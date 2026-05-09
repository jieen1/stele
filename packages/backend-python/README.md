# @stele/backend-python

Python backend for Stele v0.1. Translates validated CDL invariants into pytest source files and ships the runtime helpers those tests need.

## Install

```bash
npm install @stele/backend-python @stele/core
```

End users typically install this transitively through `@stele/cli` rather than reaching for it directly.

## What it exports

- `generatePytestFiles()` and `generatePytestSource()` — the entry points used by `@stele/cli` to emit pytest modules.
- `translateExpression()` — translate a single CDL expression into a Python expression. Useful for tooling that wants to inspect translation output.
- `getPythonRuntimeSource()` — the bundled `_stele_runtime.py` source. Stele writes this verbatim into the user's `tests/contract/` directory so generated tests can import it.
- Path constants and identifier sanitizers used by the CLI.

## Targets

The backend currently supports Python + pytest only. The translator and the runtime helper move together — adding or modifying a CDL operator means updating both sides.

For the architecture overview see [`docs/architecture.md`](../../docs/architecture.md). For the CDL operator catalog see [`docs/spec/cdl.md`](../../docs/spec/cdl.md).
