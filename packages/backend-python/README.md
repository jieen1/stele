# @stele/backend-python

Python backend for Stele v0.1. It translates validated CDL invariants into pytest files plus the runtime helpers those tests need.

## Install

```bash
npm install @stele/backend-python @stele/core
```

## What it exports

- `generatePytestSource()` and `generatePytestFiles()`
- `translateExpression()` for backend expression translation
- `getPythonRuntimeSource()` for the shared runtime helper
- Path constants and identifier sanitizers used by the CLI

The backend currently targets Python + pytest only.
