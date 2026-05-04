---
name: contract-aware-coding
description: Follow Stele contract protections when working in repositories that use protected contract and generated test files.
---

# Contract-Aware Coding

Use this skill when a project contains `stele.config.json` or protected Stele contract files.

## Guardrails

- Treat `contract/**/*.stele`, `contract/checker_impls/**/*`, `contract/.manifest.json`, and `tests/contract/**/*` as protected unless the user has approved a contract change.
- Do not make direct protected edits as part of unrelated application work.
- Ignore Python cache artifacts such as `__pycache__`, `.pyc`, and `.pyo` when reviewing generated output drift.

## Working flow

1. Run `stele check` before and after material changes when Stele is installed.
2. Use `stele list` to discover existing invariant IDs.
3. Use `stele explain <id>` to inspect why an invariant exists and where it generates output.
4. Use `stele add-checker <checker-id>` when the user needs a new checker implementation scaffold.
5. For approved protected edits, follow with the user-approved manifest refresh flow and re-run `stele check`.

## Response habits

- Explain when a requested change touches protected contract files.
- Prefer proposing the minimal contract update over editing generated files by hand.
- Surface `stele check` failures verbatim enough for the user to act on them.
