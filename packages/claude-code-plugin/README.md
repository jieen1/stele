# @stele/claude-code-plugin

Claude Code plugin bundle for Stele repositories. It ships the plugin manifest, hooks, slash-command docs, agent prompt, and skill prompt used to keep protected contract files on the approved path.

## Install

Install the Stele CLI first so `stele check` is available on `PATH`, then install this package and register the package directory as a Claude Code plugin root.

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

## What it includes

- `SessionStart` and `UserPromptSubmit` hooks that quietly inject Stele rule context into the agent session
- `PreToolUse` hook to inject file-focused context before reads/edits and deny direct edits to protected Stele files
- `PostToolUse` hook to record material source edits for later contract-maintenance review
- `Stop` hook to run `stele check`, `pytest tests/contract`, and a one-time maintenance review prompt before the agent finishes
- `/stele:init`, `/stele:check`, `/stele:add`, `/stele:explain`, `/stele:rules`, `/stele:context`, `/stele:why`, and `/stele:maintain`
- The `contract-author` subagent and `contract-aware-coding` skill

The current v0.1 command set helps agents inspect rules, understand failures, add new contract proposals, and avoid casual protected edits. The lifecycle hooks make the common path automatic: context is injected when the session starts and when files are touched, edits are observed silently, and Stop asks for a rule-maintenance review only after material source changes.

See `docs/plugin-guide.md` for the production installation and workflow details.
