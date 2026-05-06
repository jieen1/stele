# @stele/cli

Production CLI for Stele. It initializes repository scaffolding, generates contract tests, checks protected state, locks manifests, indexes rules for agents, explains failures, proposes add-only contract knowledge, and scaffolds checker implementations.

## Install

```bash
npm install --save-dev @stele/cli @stele/backend-python @stele/core
```

This package installs the `stele` executable.

## Commands

- `stele init --language python`
- `stele version`
- `stele generate [--force]`
- `stele check`
- `stele lock [--reason "..."]`
- `stele list [--severity ...] [--category ...] [--tag ...]`
- `stele rules [--json]`
- `stele agent-context [--json] [--focus <path...>]`
- `stele explain <invariant-id> [--json]`
- `stele why <rule-id-or-fingerprint> [--json]`
- `stele propose invariant --id <id> --severity <level> --description <text> --assert <expr> [--category <value>] [--rationale <text>] [--apply]`
- `stele maintenance-summary [--from <git-ref>] [--output <path>]`
- `stele add-checker <checker-id>`

Version checks can use `stele --version`, `stele version`, or `stele --stele-version`. When invoking through npm, use `npm exec -- stele --version`; `npm exec stele --version` is parsed by npm as npm's own `--version` flag.

`checker-id` is the canonical CDL checker id. Hyphenated ids such as `balance-change-has-transaction` stay hyphenated in the emitted `(checker ...)` block and are written to underscore-safe Python filenames such as `balance_change_has_transaction.py`.

Agents should use `stele agent-context` and `stele why` before touching contract-sensitive code. Newly learned durable behavior can be added through `stele propose invariant --apply`, which appends to `contract/proposals/agent-additions.stele` and never refreshes manifests or baselines by itself. Modifying or deleting existing contract rules remains a user-reviewed protected edit.

See the repository README and `docs/` guides for the full adoption flow.
