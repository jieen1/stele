# Development

How to set up, build, and work in the Stele monorepo.

## Prerequisites

- Node.js 20+
- pnpm 9.15.0 (locked via `package.json` `packageManager`)
- Python 3.10+ with `pytest` (only required for `@stele/backend-python` runtime tests and packed-adoption verification)

## Bootstrap

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm install` resolves the workspace using `pnpm-workspace.yaml`. All four packages live under `packages/*` and depend on each other through `workspace:*` references.

## Workspace commands

| Command | What it does |
| --- | --- |
| `pnpm build` | tsup build for every package. Produces `dist/` with ESM + `.d.ts`. |
| `pnpm test` | vitest in each package + Python runtime tests. |
| `pnpm typecheck` | Builds `@stele/core` and `@stele/backend-python` (their consumers need their `dist/`), then runs `tsc --noEmit` everywhere. |
| `pnpm lint` | Currently aliased to `tsc --noEmit` per package. No eslint pass at the moment. |
| `pnpm test:packed-adoption` | Packs every package into a tarball, copies the internal Python fixture to a temp dir, installs the tarballs into it, and walks `init → generate → pytest → lock → check`. The strongest correctness signal we have. |
| `pnpm release:dry-run` | `publish-npm.mjs --dry-run` — packs everything and runs `npm publish --dry-run`. |
| `pnpm release:publish` | The real release, gated by trusted publishing in CI. See [`release.md`](release.md). |

Per-package: prefix any of these with `pnpm --filter @stele/<name>`. Examples:

```bash
pnpm --filter @stele/core test
pnpm --filter @stele/cli build
pnpm --filter @stele/backend-python test
```

## Source conventions

- **ESM, strict TypeScript.** `tsconfig.base.json` sets `target: ES2022`, `moduleResolution: Bundler`, `strict: true`. Relative imports must include the `.js` extension (we ship native ESM):

  ```ts
  // good
  import { lex } from "./lexer/lexer.js";
  // wrong
  import { lex } from "./lexer/lexer";
  ```

- **No comments unless they explain *why*.** The codebase is intentionally terse. Don't paraphrase what well-named identifiers already say.
- **No backward-compat shims, dead-flag toggles, or `// removed:` markers.** Delete what you remove.
- **Pure functions in `@stele/core`.** No clock, no random, no env, no filesystem outside the modules that explicitly own IO (`loader/`, `manifest/`, `baseline/io.ts`, `report/`).
- **Sort iteration outputs.** If a generator's output depends on iteration order, sort. See `util/array.ts::uniqueSortedStrings`.

## Working in each package

### `@stele/core`

The center of gravity. Most changes start with a parser/validator/operator addition, then thread through normalizer → registry → generator. Test files mirror source paths: `packages/core/tests/<area>/<file>.test.ts`.

When you change the AST or operator registry, run:

```bash
pnpm --filter @stele/core test
pnpm --filter @stele/backend-python test  # generated output may shift
pnpm test:packed-adoption                 # end-to-end safety net
```

### `@stele/backend-python`

The translator (`src/translator.ts`) plus the Python runtime (`src/runtime/_stele_runtime.py`). When you add or modify an operator, both need a change:

1. Update the TypeScript translator branch.
2. Update the Python runtime helper.
3. Add coverage in `tests/translator.test.ts` (TS) and `tests/test_runtime.py` (Python).

### `@stele/cli`

Commands live under `packages/cli/src/commands/` — one file per command. Register new commands in `packages/cli/src/index.ts`. Integration tests are heavy: `tests/cli.test.ts` and `tests/commands.test.ts` cover most surface.

If you change CLI exit codes, that's a breaking change and `docs/spec/cdl.md` (Exit codes section) must move with it.

### `@stele/claude-code-plugin`

Hook scripts under `scripts/` are Node.js. They run inside the Claude Code agent's process and **must fail closed** — if a script throws, the hook should block the agent's action, never silently allow it. Tests under `tests/` exercise each hook with simulated tool calls.

Slash command docs (`commands/*.md`), subagent prompts (`agents/*.md`), and skills (`skills/*/SKILL.md`) are agent-facing prompts. Treat them as carefully as code: an agent that misreads them produces wrong protected edits.

## Common workflows

### Add a new CDL operator

1. Add the operator spec to `packages/core/src/registry/operators.ts`.
2. Add the validator branch in `packages/core/src/validator/`.
3. Add the translator branch in `packages/backend-python/src/translator.ts`.
4. Add the runtime helper in `packages/backend-python/src/runtime/_stele_runtime.py`.
5. Update [`docs/spec/cdl.md`](../spec/cdl.md) — operator table and any examples.
6. Add tests in `packages/core/tests/registry/`, `packages/backend-python/tests/`.
7. Run `pnpm test && pnpm test:packed-adoption`.

### Add a new CLI command

1. Create `packages/cli/src/commands/<name>.ts`. Keep it thin — most logic belongs in `@stele/core`.
2. Register the command in `packages/cli/src/index.ts`.
3. Add tests in `packages/cli/tests/commands.test.ts` (or a focused `<name>.test.ts`).
4. Update `packages/cli/README.md` and the relevant section in the root `README.md`.
5. If the command is agent-facing, also add a `/stele:<name>` slash command in `packages/claude-code-plugin/commands/<name>.md` and update the plugin guide.

### Bump a dependency

We pin loosely (`^`) and rely on `pnpm-lock.yaml`. Run `pnpm install` after editing a `package.json` and commit the lockfile change in the same commit as the dependency change.

## What not to do

- Don't bypass the path-safety helpers when adding file IO. Look at `packages/core/src/manifest/manifest.ts` and `packages/claude-code-plugin/scripts/path-utils.js` for the established patterns.
- Don't change the on-disk `.manifest.json` or `.baseline.json` formats without a version bump and a migration note in `docs/spec/cdl.md`.
- Don't introduce non-deterministic generator output. If a test is order-dependent, sort.
- Don't merge a change to `@stele/core` or `@stele/backend-python` without running `pnpm test:packed-adoption` locally.
