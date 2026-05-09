# cursor-demo

Tiny example showing how to enable Stele inside a Cursor project.

## What this demonstrates

- A minimal Python project (`src/cart.py`) with a Stele contract under
  `contract/main.stele` that protects two invariants.
- The `stele install --agent cursor` workflow that generates
  `.cursor/rules/stele.md`, the static rules file that Cursor injects into
  every prompt.
- The honest caveat: Cursor's static rules are **best-effort**; the agent
  may ignore them. Hard enforcement runs in CI via
  `@stele/github-action`.

## Try it locally

```bash
# from this directory
stele install --agent cursor
# inspect the generated file
cat .cursor/rules/stele.md
# undo
stele install --agent cursor --uninstall
```

## What you should see

`stele install --agent cursor` prints:

```
Installed Stele rules into <path>/.cursor/rules/stele.md.
Note: Cursor static rules are best-effort; agents may ignore them.
For hard enforcement use @stele/github-action.
```

The generated `.cursor/rules/stele.md` starts with the auto-marker
`<!-- stele-auto:v1 -->` so the installer can detect manual edits and
refuse to overwrite without `--force`.

## What about the composer-rule shell hook?

Pass `--enable-shell` to also write
`.cursor/composer/stele-check.sh`. That script runs `stele check --json`
after composer-rule actions, but it cannot pre-empt a tool call the way
Claude Code's `PreToolUse` hook does. Treat it as a fast feedback loop,
not as a blocking gate.

## Why CI enforcement still matters

The Stele architecture has three layers:

1. **CDL** (the contract DSL, source of truth).
2. **Generated tests** (`tests/contract/`, run by your normal test suite).
3. **Editor hooks** (Claude Code, Cursor).

Cursor only participates in layer 3, and softly. Make sure layer 2 runs
in CI through `@stele/github-action`; that is the layer that hard-blocks
contract regressions for Cursor users.
