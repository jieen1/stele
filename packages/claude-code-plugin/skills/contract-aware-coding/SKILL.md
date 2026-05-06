---
name: contract-aware-coding
description: Follow Stele contract protections when working in repositories that use protected contract and generated test files.
---

# Contract-Aware Coding

Use this skill when a project contains `stele.config.json` or protected Stele contract files.

## Guardrails

- Treat `contract/**/*.stele`, `contract/checker_impls/**/*`, `contract/.manifest.json`, and `tests/contract/**/*` as protected unless the user has approved a contract change.
- Do not make direct protected edits as part of unrelated application work.
- Ignore Python cache artifacts ending in `.pyc` or `.pyo` when reviewing generated output drift. Do not ignore ordinary source files just because they live under a `__pycache__` directory.
- Expect the Stele plugin hooks to provide context automatically at session start, before relevant tool use, and at Stop. Use the slash commands when you need to inspect more deeply or recover from a failure.

## Working flow

1. Run `stele check` before and after material changes when Stele is installed.
2. Run `stele agent-context --focus <changed-file>` before editing source that may touch protected behavior.
3. Use `stele rules --json` to discover the complete project rule inventory.
4. Use `stele why <rule-id-or-fingerprint>` when a rule or check report needs explanation.
5. Use `stele explain <id>` to inspect why an invariant exists and where it generates output.
6. Use `stele propose invariant --apply ...` to add newly learned contract knowledge. This is add-only and does not refresh locks.
7. Use `stele maintenance-summary --from <base> --output .stele/maintenance/summary.md` during periodic review so recent learning can become proposed contract additions.
8. Use `stele add-checker <checker-id>` when the user needs a new checker implementation scaffold.
9. For approved protected edits, follow with the user-approved manifest refresh flow and re-run `stele check`.

## Rule maintenance policy

- Prefer repairing ordinary source code, fixtures, or scenario setup before touching protected contract material.
- Adding new rules is allowed through `stele propose invariant --apply` when the agent learned durable project behavior.
- Modifying or deleting existing contract rules requires explicit user review before editing protected files.
- When Stop reports `Stele maintenance review required`, read `.stele/maintenance/summary.md`; either add a new invariant proposal for durable knowledge or explain why no new rule is needed.
- Do not run `stele lock`, `baseline-update`, or generated output refreshes to hide a failing rule unless the user approved the contract change and reason.
- Generated tests remain derived output; never hand-edit them to make a failure disappear.

## Response habits

- Explain when a requested change touches protected contract files.
- Prefer proposing the minimal contract update over editing generated files by hand.
- Surface `stele check` failures verbatim enough for the user to act on them.
- When you learn durable behavior during implementation, summarize it and add a proposed invariant instead of leaving it only in chat.
