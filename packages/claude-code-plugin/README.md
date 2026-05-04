# @stele/claude-code-plugin

Claude Code plugin bundle for Stele repositories. It ships the plugin manifest, hooks, slash-command docs, agent prompt, and skill prompt used to keep protected contract files on the approved path.

## Install

Install the Stele CLI first so `stele check` is available on `PATH`, then install this package and register the package directory as a Claude Code plugin root.

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

## What it includes

- `PreToolUse` hook to deny direct edits to protected Stele files
- `Stop` hook to run `stele check` before the agent finishes
- `/stele:init`, `/stele:check`, `/stele:add`, and `/stele:explain`
- The `contract-author` subagent and `contract-aware-coding` skill

The current v0.1 command set is exactly `/stele:init`, `/stele:check`, `/stele:add`, and `/stele:explain`.

See `docs/plugin-guide.md` for the production installation and workflow details.
