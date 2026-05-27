# Stele Claude Code Plugin Guide

`@stele/claude-code-plugin` is the editor-side guardrail bundle for Stele repositories. It does not replace the CLI. Instead, it keeps Claude Code agents on the approved path by injecting contract context, blocking direct edits to protected files, observing material source edits, running the final contract checks, and nudging agents to add newly learned rules through the add-only proposal flow.

## Install the CLI and plugin

Published-package install target:

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

Until public publish, use the same packed `@stele/core`, `@stele/backend-python`, and `@stele/cli` tarballs that `pnpm test:packed-adoption` verifies for external adoption. The plugin package can be packed from this workspace as well, but editor registration is not part of the packed-adoption automation because the plugin is hosted by Claude Code rather than by the application under test.

The hooks first look for project-local installs, including `node_modules/.bin/stele` and common `.venv` Python locations, then fall back to `PATH`. That means normal `npm install --save-dev @stele/cli @stele/claude-code-plugin` installs work without wrapping Claude Code in a custom `PATH`.

After installing the package, register the package directory that contains `.claude-plugin/plugin.json` as a Claude Code plugin root.

### Register the plugin

The plugin tarball lands at `<app>/node_modules/@stele/claude-code-plugin/` after `npm install`. To make Claude Code actually load it, you need two edits in your user-level Claude Code config (NOT in the app repo).

1. Add a project-scoped plugin entry in `~/.claude/plugins/installed_plugins.json` (create the file if it doesn't exist):

   ```json
   {
     "stele@local": [
       {
         "scope": "project",
         "projectPath": "/absolute/path/to/your/app",
         "installPath": "/absolute/path/to/your/app/node_modules/@stele/claude-code-plugin"
       }
     ]
   }
   ```

   - `projectPath` — your application's repo root (the directory that contains `stele.config.json`).
   - `installPath` — the directory containing `.claude-plugin/plugin.json`. Under normal `npm install` this is `<projectPath>/node_modules/@stele/claude-code-plugin`.

2. Enable the plugin in `~/.claude/settings.json`:

   ```json
   {
     "enabledPlugins": {
       "stele@local": true
     }
   }
   ```

3. Restart Claude Code (close and reopen, or start a new session) so the plugin manifest is loaded.

You can verify activation by opening a session in your application repo and confirming a `SessionStart` context injection appears. If nothing happens, the most common cause is `installPath` pointing at the wrong directory — it must be the dir that contains `.claude-plugin/plugin.json`, not the package's `src/` or `dist/`.

## What the plugin ships

- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- lifecycle scripts for context injection, edit observation, protected-file protection, and final validation
- slash-command docs for `/stele:init`, `/stele:check`, `/stele:add`, `/stele:explain`, `/stele:rules`, `/stele:context`, `/stele:why`, and `/stele:maintain`
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

- patterns must be non-empty, non-blank strings
- patterns must stay project-relative
- bracket globs such as `docs/[a-z].md` are rejected

Python cache artifacts inside generated/checker directories are ignored only when they end in `.pyc` or `.pyo`. Ordinary files remain protected even when they live under a `__pycache__` directory.

## Lifecycle behavior

The plugin follows Claude Code's hook lifecycle so rule maintenance does not depend on memory or manual cadence:

- `SessionStart` runs `stele agent-context` and injects the result as hidden session context.
- `UserPromptSubmit` runs focused context discovery for changed files when available.
- `PreToolUse` runs before `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Bash`; it injects file-specific context and then protects configured paths from direct edits.
- `PostToolUse` records edited target paths to `.stele/agent/session-observations.jsonl` without surfacing output.
- `Stop` runs validation and, after material source edits, generates `.stele/maintenance/summary.md` and asks the agent once to decide whether durable new knowledge should be added with `stele propose invariant --apply`.

This is intentionally asymmetric: adding new proposed rules is easy and add-only, while modifying or deleting existing contract state still requires explicit user review.

## `PreToolUse` behavior

The protection side of the `PreToolUse` hook runs before Claude Code edit tools such as `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and write-like `Bash` commands.

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
python -m pytest tests/contract -q
```

in `CLAUDE_PROJECT_DIR`, forwarding stdout and stderr from the CLI and pytest.

The hook exits successfully only when both commands return `0`. It blocks completion when:

- the `stele` executable is missing
- `stele check` exits non-zero
- Python or pytest is unavailable
- `python -m pytest tests/contract -q` exits non-zero
- the spawned process errors or is terminated
- material source edits happened and the agent has not yet reviewed `.stele/maintenance/summary.md`

On a maintenance-review block, the agent should inspect the summary and either add durable new behavior through:

```bash
stele propose invariant --id <ID> --severity <level> --description "<text>" --assert "<cdl-assertion>" --apply
```

or explicitly say no new rule is needed. Existing contract edits still go through the user-approved protected-file flow.

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

### `/stele:rules`

Runs:

```bash
stele rules --json
```

Use it to discover the full rule inventory before editing contract-sensitive source code. The JSON includes invariants, scenarios, code-shape rules, protected globs, source locations, generated test paths, dependencies, and checker/scenario linkage.

### `/stele:context`

Runs:

```bash
stele agent-context --focus <changed-file>
```

Use it before implementation work in a Stele repository. It reminds the agent to repair source or fixtures first, add new knowledge through proposal commands, and ask the user before modifying or deleting existing contract material.

### `/stele:explain`

Runs:

```bash
stele explain <id>
```

Use it to inspect the exact invariant source, generated test path, dependencies, rationale, and checker linkage for a known invariant id. Add `--json` when another agent or tool will consume the result.

### `/stele:why`

Runs:

```bash
stele why <rule-id-or-fingerprint>
```

Use it when a rule or check-report fingerprint needs an actionable explanation. The output tells the agent whether to repair source, add a new rule, regenerate after approval, or ask the user to review a contract change.

### `/stele:maintain`

Runs:

```bash
stele maintenance-summary --from main --output .stele/maintenance/summary.md
```

Use it manually when you want an explicit review. The plugin also runs this automatically from the `Stop` hook after material source edits. The summary captures recent file changes, contract inventory, check status, and candidate questions for newly learned behavior. Durable new knowledge should be added through `stele propose invariant --apply`.

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
- `contract-aware-coding`: a skill that reminds agents to avoid casual edits to protected files and to use `stele check`, `stele agent-context`, `stele rules`, `stele why`, `stele explain`, `stele propose invariant`, `stele maintenance-summary`, and `stele add-checker`

These assets are advisory workflow helpers; the hard guardrails and automatic maintenance reminders are still the hooks plus the CLI.

## Troubleshooting

### The plugin blocks every protected edit

That is expected until the user approves a contract update. Use the approval flow and then apply the protected change intentionally.

### The session stops with `Unable to run "stele check"`

The CLI was not found in project-local `node_modules/.bin` or on `PATH`. Install `@stele/cli` in the application repository or make sure the `stele` executable is resolvable in the Claude Code host environment.

### The session stops with a maintenance review

Read `.stele/maintenance/summary.md`. If the session revealed durable project behavior, add a new proposal with `stele propose invariant --apply`. If not, state that no contract addition is needed and continue. The Stop hook only asks once per session to avoid loops.

### `stele check` fails in `Stop`

Read the CLI output. Exit code `2` means generated-file drift; exit code `3` means manifest/protected-file drift or another protected-state verification failure.

### The hook fails closed after a config edit

Validate `stele.config.json`:

- `protected` must be an array of non-empty, non-blank project-relative glob strings
- protected globs must be project-relative
- bracket glob syntax is not supported

### The plugin does not register

Point Claude Code at the installed package directory that contains `.claude-plugin/plugin.json`, not at the repository root unless the plugin package itself is the registered root.
