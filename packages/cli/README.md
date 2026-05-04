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

`checker-id` is the canonical CDL checker id. Hyphenated ids such as `balance-change-has-transaction` stay hyphenated in the emitted `(checker ...)` block and are written to underscore-safe Python filenames such as `balance_change_has_transaction.py`.

See the repository README and `docs/` guides for the full adoption flow.
