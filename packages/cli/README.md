# @stele/cli

Production CLI for Stele. Initializes repository scaffolding, generates contract tests, checks protected state, locks manifests, indexes rules for agents, explains failures, proposes add-only contract knowledge, and scaffolds checker implementations.

## Install

```bash
npm install --save-dev @stele/cli @stele/backend-python @stele/core
```

This package installs the `stele` executable.

## Commands

User-facing:

- `stele init --language python` — scaffold `contract/`, `tests/contract/`, and `stele.config.json`.
- `stele generate [--force]` — regenerate the pytest suite from CDL.
- `stele check [--diff-from <base>] [--json] [--report-file <path>] [--lenient]` — verify generated drift, manifest, and baseline.
- `stele lock --reason "..."` — snapshot SHA-256 hashes of the protected file set.
- `stele unlock --reason "..." [--confirm]` — remove locks for emergency edits.
- `stele baseline-init --reason "..."` — create a baseline that suppresses known legacy violations.
- `stele baseline-update --reason "..."` — refresh an existing baseline.
- `stele add-checker <checker-id>` — scaffold a Python checker implementation file and print the matching CDL block.
- `stele dev [--once]` — watch CDL for changes and auto-regenerate.
- `stele doc [--format markdown|html] [--output <path>]` — render contract documentation.

Agent-facing (read-only or add-only):

- `stele list [--severity ...] [--category ...] [--tag ...] [--format table|json]`
- `stele rules [--json]`
- `stele agent-context [--json] [--focus <path>...]`
- `stele explain <invariant-id> [--json]`
- `stele why <id-or-fingerprint> [--json]`
- `stele propose invariant --id <id> --severity <level> --description <text> --assert <expr> [--category <value>] [--rationale <text>] [--apply]`
- `stele maintenance-summary [--from <git-ref>] [--output <path>]`

`stele propose --apply` only appends to `contract/proposals/agent-additions.stele`. It never refreshes manifests, baselines, or generated tests. Modifying or deleting an existing rule remains a user-reviewed protected edit.

## Version checks

```bash
stele --version
stele version
npx stele --version
npm exec -- stele --version
```

Avoid `npm exec stele --version`; npm parses that as npm's own version flag. Use `npm exec -- stele --version` instead.

## Checker ids

`checker-id` is the canonical CDL checker id. Hyphenated ids like `balance-change-has-transaction` stay hyphenated in emitted CDL blocks and become underscore-safe Python filenames such as `balance_change_has_transaction.py`.

## Documentation

For the full adoption workflow see [`docs/guides/python-integration.md`](../../docs/guides/python-integration.md). For the language reference see [`docs/spec/cdl.md`](../../docs/spec/cdl.md).
