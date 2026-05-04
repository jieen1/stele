# Stele Claude Code Plugin Guide

`@stele/claude-code-plugin` is the editor-side guardrail bundle for Stele repositories. It does not replace the CLI. Instead, it keeps Claude Code agents on the approved path by blocking direct edits to protected files and by running `stele check` before an agent session ends.

## Install the CLI and plugin

Published-package install target:

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

Until public publish, use the same packed `@stele/core`, `@stele/backend-python`, and `@stele/cli` tarballs that `pnpm test:packed-adoption` verifies for external adoption. The plugin package can be packed from this workspace as well, but editor registration is not part of the packed-adoption automation because the plugin is hosted by Claude Code rather than by the application under test.

The plugin requires the `stele` executable to be available on `PATH`. Its `Stop` hook shells out to `stele check`; if the CLI is missing, the hook blocks completion.

After installing the package, register the package directory that contains `.claude-plugin/plugin.json` as a Claude Code plugin root.

## What the plugin ships

- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- slash-command docs for `/stele:init`, `/stele:check`, `/stele:add`, and `/stele:explain`
- the `contract-author` subagent prompt
- the `contract-aware-coding` skill

## Protected paths

By default, the plugin treats these paths as protected:

- `contract/**/*.stele`
- `contract/checker_impls/**/*`
- `contract/.manifest.json`
- `tests/contract/**/*`

The hook loads the `protected` array from `stele.config.json` when present. If the field is missing, the defaults above apply. If the field is explicitly set to `[]`, the hook allows all paths.

The protected-glob parser is intentionally conservative:

- patterns must be strings
- patterns must stay project-relative
- bracket globs such as `docs/[a-z].md` are rejected

Python cache artifacts inside generated/checker directories are ignored only when they end in `.pyc` or `.pyo`. Ordinary files remain protected even when they live under a `__pycache__` directory.

## `PreToolUse` behavior

The `PreToolUse` hook runs before Claude Code edit tools such as `Write`, `Edit`, `MultiEdit`, and `NotebookEdit`.

When the target path resolves to a protected file, the hook returns a deny decision with this reason:

```text
This file is protected by Stele. Use /stele:add or ask the user to approve a contract update.
```

The hook fails closed:

- malformed `stele.config.json` blocks the edit
- malformed hook stdin blocks the edit
- invalid `protected` configuration blocks the edit

That is deliberate. If the protection configuration cannot be trusted, the plugin does not permit protected edits.

## `Stop` behavior

The `Stop` hook runs:

```bash
stele check
```

in `CLAUDE_PROJECT_DIR`, forwarding stdout and stderr from the CLI.

The hook exits successfully only when `stele check` returns `0`. It blocks completion when:

- the `stele` executable is missing
- `stele check` exits non-zero
- the spawned process errors or is terminated

## Slash commands

The plugin documents four slash commands:

### `/stele:init`

Runs:

```bash
stele init
```

Use it to scaffold Stele into a repository that does not yet have `stele.config.json`, `contract/main.stele`, and `tests/contract/conftest.py`.

### `/stele:check`

Runs:

```bash
stele check
```

Use it before and after material work in a Stele repository, and treat any non-zero exit as blocking.

### `/stele:add`

Use this when the user explicitly wants to author or extend protected contract material. The command doc instructs the agent to:

1. clarify whether the change is an invariant, checker, import, or generated-output change
2. run `stele add-checker <checker-id>` when a new Python checker scaffold is needed; use the canonical CDL checker id, which may be hyphenated
3. present the emitted checker block or contract snippet for approval
4. route the protected-file edit through the approved contract-change flow

`/stele:add` is the plugin's entrypoint for contract-authoring work; it is not a separate CLI subcommand.

### `/stele:explain`

Runs:

```bash
stele explain <id>
```

Use it to inspect the exact invariant source, generated test path, dependencies, rationale, and checker linkage for a known invariant id.

## Legal contract-change flow

Protected contract state should only change after the user explicitly approves the contract update. Once approved, use this sequence:

```bash
stele generate --force
python -m pytest tests/contract -q
stele lock --reason "approved contract update"
stele check
```

Why this flow exists:

- `generate --force` refreshes managed output after an intentional contract or checker change
- pytest proves the generated tests still pass against the real app state
- `stele lock` refreshes `contract/.manifest.json` only after output is current
- `stele check` proves the repository is back in an approved, locked state

## Agent and skill behavior

The package ships two behavior assets:

- `contract-author`: a subagent prompt for approved contract authoring work
- `contract-aware-coding`: a skill that reminds agents to avoid casual edits to protected files and to use `stele check`, `stele list`, `stele explain`, and `stele add-checker`

These assets are advisory workflow helpers; the hard guardrails are still the hooks plus the CLI.

## Troubleshooting

### The plugin blocks every protected edit

That is expected until the user approves a contract update. Use the approval flow and then apply the protected change intentionally.

### The session stops with `Unable to run "stele check"`

The CLI is not on `PATH` for the Claude Code host process. Install `@stele/cli` and make sure the `stele` executable is resolvable in that environment.

### `stele check` fails in `Stop`

Read the CLI output. Exit code `2` means generated-file drift; exit code `3` means manifest/protected-file drift or another protected-state verification failure.

### The hook fails closed after a config edit

Validate `stele.config.json`:

- `protected` must be an array of strings
- protected globs must be project-relative
- bracket glob syntax is not supported

### The plugin does not register

Point Claude Code at the installed package directory that contains `.claude-plugin/plugin.json`, not at the repository root unless the plugin package itself is the registered root.
