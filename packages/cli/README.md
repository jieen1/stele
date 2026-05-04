# @stele/cli

Production CLI for Stele. It initializes repository scaffolding, generates contract tests, checks protected state, locks manifests, lists invariants, explains rules, and scaffolds checker implementations.

## Install

```bash
npm install --save-dev @stele/cli @stele/backend-python @stele/core
```

This package installs the `stele` executable.

## Commands

- `stele init --language python`
- `stele generate [--force]`
- `stele check`
- `stele lock [--reason "..."]`
- `stele list [--severity ...] [--category ...] [--tag ...]`
- `stele explain <invariant-id>`
- `stele add-checker <checker-id>`

See the repository README and `docs/` guides for the full adoption flow.
