# @stele/claude-code-plugin

Claude Code plugin bundle for Stele repositories. Ships the plugin manifest, hook scripts, slash-command docs, subagent prompts, and skill prompts that keep an agent on the approved path.

## Install

Install the Stele CLI first so `stele check` is available on `PATH`, then install this package and register its directory as a Claude Code plugin root.

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

## What it includes

- **`SessionStart` and `UserPromptSubmit` hooks** — quietly inject Stele rule context into the agent session.
- **`PreToolUse` hook** — inject file-focused context before reads/edits, deny direct edits to protected Stele files. Fails closed.
- **`PostToolUse` hook** — record material source edits for later contract-maintenance review.
- **`Stop` hook** — run `stele check` and `pytest tests/contract`, then prompt for a one-time maintenance review before the agent finishes.
- **Slash commands** — `/stele:init`, `/stele:check`, `/stele:add`, `/stele:explain`, `/stele:rules`, `/stele:context`, `/stele:why`, `/stele:maintain`.
- **Subagents** — `contract-author` (authors approved contract changes through the proposal flow), `contract-fixer` (fixes source code when contract tests fail without touching protected files), `contract-reviewer` (reviews proposed changes for quality, consistency, and safety).
- **Skills** — `contract-aware-coding` (general-purpose guardrails) and `contract-debugging` (violation investigation).

The current v0.1 surface helps agents inspect rules, understand failures, add new contract proposals, and avoid casual protected edits. The lifecycle hooks make the common path automatic: context is injected when the session starts and when files are touched, edits are observed silently, and `Stop` requests a rule-maintenance review only after material source changes.

## Documentation

See [`docs/guides/claude-code-plugin.md`](../../docs/guides/claude-code-plugin.md) for the production installation and workflow details.
