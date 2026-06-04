# CLAUDE.md

Notes for AI assistants working in this repository. Keep changes small, deterministic, and respectful of the security model — this is the codebase that protects other projects from agent damage, and the bar for trust is correspondingly high.

## What this repo is

Stele is a contract management framework. Users adopt it to lock business invariants into protected files an agent cannot edit, regenerate tests deterministically, and have Claude Code refuse direct writes to protected paths. The v0.1 runtime targets Python applications using `pytest`.

This repo is a **pnpm monorepo**. The publishable packages today:

- `packages/core` — TypeScript core: lexer → parser → validator → normalizer → registry → manifest → generator coordinator → report.
- `packages/backend-python` — TypeScript translator that turns validated CDL into pytest source, plus the Python runtime helper.
- `packages/backend-go` — Go test generation.
- `packages/backend-rust` — Rust test generation.
- `packages/backend-java` — Java/JUnit5 test generation.
- `packages/backend-typescript` — TypeScript/vitest test generation.
- `packages/cli` — the `stele` executable (Commander.js).
- `packages/claude-code-plugin` — hook scripts, slash command docs, subagent prompts, and skill prompts.
- `packages/agent-hooks` — shared hook SDK (`matchProtectedPath`, etc.).
- `packages/mcp-server` — MCP server bridging Stele to Claude Code / Cursor / other agents.
- `packages/github-action` — packaged GitHub Action for CI.
- `packages/call-graph-core` — language-agnostic call-graph data structures and `extern:` resolver used by every Phase B evaluator.
- `packages/trace-evaluator`, `packages/type-state-evaluator`, `packages/effect-evaluator`, `packages/type-driven-evaluator` — Phase B mechanism evaluators (TS source today; Python/Go/Rust/Java backends in B.2/B.3).
- `packages/architecture-core` — architecture/layering primitives used by the CLI's architecture stage.

Run `pnpm -r ls --json --depth -1 | jq '[.[].name]'` for the live list — the count grows with new evaluators / backends.

The repo is self-protected via `contract/main.stele` + `contract/generated/ddd-typedriven.stele` (currently **52 invariants** + ~100 non-invariant declarations across 13 contract mechanisms — run `stele list` for the live invariant count). Mechanisms in use on Stele's own source: `invariant`, `checker`, `boundary`, `class-shape`, `function-shape`, `type-policy`, `file-policy`, `architecture`, `core-node`, `branded-id`, `trace-policy`, `type-state`, `effect-policy` (the last gates unresolved-call fail-closed per-policy by `target-scope` membership since Closeout 1, 2026-05-25). (`smart-ctor` was a 14th mechanism, removed 2026-06-04 — it only binds class value-objects, but Stele's brands are string aliases; its intent is covered by the `*_USES_BRANDED_TYPE` invariants.) See [`docs/internal/self-protection-coverage-matrix.md`](docs/internal/self-protection-coverage-matrix.md) for the mechanism × package matrix and [`docs/design/self-dogfooding/`](docs/design/self-dogfooding/) for the plan that drove the expansion from 35 → 48 invariants during 2026-Q2. Bugs in security-critical paths are caught by `stele check` + `pytest tests/contract` + the 142 negative tests under `contract/checker_impls/test_negative.py`.

## Workspace commands

Run from the repo root unless noted.

```bash
pnpm install
pnpm build                  # builds every package via tsup
pnpm test                   # vitest in each package + python runtime tests
pnpm typecheck              # core + backend-python build, then per-package tsc --noEmit
pnpm lint                   # tsc-only lint (we don't run eslint at the moment)
pnpm test:packed-adoption   # packs tarballs, installs into a fresh fixture, runs init/generate/check end-to-end
pnpm release:dry-run        # full pre-publish verification (no upload)
pnpm release:publish        # real npm publish (maintainers only)
```

Per-package: `pnpm --filter @stele/core build`, `pnpm --filter @stele/cli test`, etc.

## Source conventions

- **ESM only.** TypeScript files use `.js` extensions in relative imports (`from "./types.js"`) because we ship as native ESM. Don't change to extensionless or `.ts` imports.
- **Strict TypeScript.** `tsconfig.base.json` sets `strict: true`, `target: ES2022`, `moduleResolution: Bundler`. New code must compile with no `any`-leaks.
- **Pure functions in `@stele/core`.** Same input must produce the same output. Generated source code is byte-stable; the manifest layer hashes it. Anything that introduces nondeterminism (clock, random, env, filesystem ordering) is a defect.
- **Vitest for TS, pytest for Python.** Test files live in each package's `tests/` directory.
- **No comments unless they explain the *why*.** The codebase is already terse; redundant comments rot.
- **Don't add backward-compat shims, dead-flag toggles, or `// removed:` markers.** When you remove code, remove it.
- **Use `Edit` over `Write` for existing files.** Don't rewrite a file when a diff would do.

## Architecture rules to respect

- **Core engine is pure.** `coordinateGeneration()` and `verifyGenerated()` must remain deterministic. If you touch the generator, run `pnpm --filter @stele/backend-python test` and the packed-adoption check.
- **Manifest hashing must not change without a version bump.** `writeManifest`/`verifyManifest` use SHA-256; the on-disk `.manifest.json` format is part of the user contract.
- **Path safety is the hot path.** Any new file IO in `packages/cli` or `packages/claude-code-plugin/scripts/` must resolve through the existing path-safety helpers — never construct paths from raw user/agent input. Look at `packages/claude-code-plugin/scripts/path-utils.js` and the validator's path checks before adding new IO sites.
- **Hooks fail closed.** Plugin scripts under `packages/claude-code-plugin/scripts/` (`pre-tool-protect.js`, `stop-validate.js`, etc.) must deny on error, not allow. If a script throws, the hook should block the agent's action.
- **CLI exit codes are part of the contract.** `stele check` exits `0` (clean), `2` (generated drift), `3` (manifest/protected drift). Don't repurpose them.

## Where things live

| You want to … | Look here |
| --- | --- |
| Change CDL grammar or operators | `packages/core/src/{lexer,parser,validator,registry}` and `docs/spec/cdl.md` |
| Change pytest output | `packages/backend-python/src/translator.ts`, `runtime/`, `templates/` |
| Add or change a CLI command | `packages/cli/src/commands/<name>.ts`, register in `packages/cli/src/index.ts` |
| Change agent-facing slash commands | `packages/claude-code-plugin/commands/<name>.md` |
| Change protect/observe/stop hooks | `packages/claude-code-plugin/scripts/*.js`, registered in `hooks/hooks.json` |
| Update subagent or skill prompts | `packages/claude-code-plugin/agents/`, `packages/claude-code-plugin/skills/` |
| Fix release plumbing | `scripts/publish-npm.mjs`, `scripts/verify-packed-adoption.mjs`, `.github/workflows/publish.yml` |
| Change the demo/finance example | `examples/finance-guard/` |
| Change the internal Python adoption fixture | `fixtures/python-app/` |

## Documentation map

- [`docs/README.md`](docs/README.md) — index of all docs.
- [`docs/architecture.md`](docs/architecture.md) — concise tour of layers and data flow.
- [`docs/design/项目设计文档.md`](docs/design/项目设计文档.md) — original Chinese design blueprint (authoritative for *intent*, sometimes ahead of or behind shipped code).
- [`docs/spec/cdl.md`](docs/spec/cdl.md) — CDL spec, narrow and implementation-grounded. Source of truth for grammar, operators, error codes, exit codes.
- [`docs/guides/python-integration.md`](docs/guides/python-integration.md), [`docs/guides/claude-code-plugin.md`](docs/guides/claude-code-plugin.md) — user-facing guides.
- [`docs/strategy/`](docs/strategy/) — competitive landscape, extension opportunities, roadmap (Chinese).
- [`docs/internal/codebase-analysis.md`](docs/internal/codebase-analysis.md), [`docs/internal/test-coverage-gap-report.md`](docs/internal/test-coverage-gap-report.md) — internal audit snapshots, dated 2026-05-08. Treat as historical context, not as live invariants.
- [`docs/internal/self-protection-coverage-matrix.md`](docs/internal/self-protection-coverage-matrix.md), [`docs/internal/self-dogfooding-2026-Q2.md`](docs/internal/self-dogfooding-2026-Q2.md) — current self-protection coverage and the 2026-Q2 self-dogfooding plan summary.
- [`docs/design/self-dogfooding/`](docs/design/self-dogfooding/) — the 6-phase plan that took Stele from 2 → 14 mechanisms on its own source.
- [`docs/contributing/development.md`](docs/contributing/development.md), [`docs/contributing/testing.md`](docs/contributing/testing.md), [`docs/contributing/release.md`](docs/contributing/release.md) — how to develop, test, and release.

When updating documentation, **update the spec or guide that the code uses**, not the design blueprint. The blueprint is a frozen reference.

## Pitfalls

- **Don't claim work is done without running `pnpm test:packed-adoption`** when you touched anything in `packages/core`, `packages/backend-python`, or `packages/cli`. The unit tests don't cover the cross-package install/initialize/generate/check loop.
- **Don't add a new top-level CDL form, operator, or error code without updating `docs/spec/cdl.md`** in the same change. The spec is the user-facing contract.
- **Pre-publish state.** Public installs go through tarballs from `local-packages/` (Windows) or hand-built artifacts. The npm registry path is documented but not yet exercised. Don't add docs that imply the registry path is the default.
- **Determinism.** If a test is flaky on ordering, the fix is usually `uniqueSortedStrings` or an explicit sort, not retries.
- **Chinese filenames are intentional.** `docs/design/项目设计文档.md` and `docs/strategy/roadmap.md` are kept in their original language. Don't translate them as a side effect of unrelated edits.

## Versioning

All eight packages are pinned at `0.1.0` and release together. Bump in lockstep. The release script (`scripts/publish-npm.mjs`) verifies that packed manifests do not contain `workspace:*` before uploading.

## Self-protection plugin setup

This repo protects itself via the `@stele/claude-code-plugin`. To activate hooks:

1. Ensure packages are built: `pnpm build`
2. Register the plugin as a local project-scoped plugin in `~/.claude/plugins/installed_plugins.json`:
   ```json
   "stele@local": [
     {
       "scope": "project",
       "projectPath": "<this-repo-root>",
       "installPath": "<this-repo-root>/packages/claude-code-plugin"
     }
   ]
   ```
3. Enable in `~/.claude/settings.json`:
   ```json
   "enabledPlugins": { "stele@local": true }
   ```

Hooks enforce:
- **PreToolUse**: Block writes to `contract/**/*.stele`, `contract/checker_impls/**/*`, `contract/.manifest.json`, `tests/contract/**/*`
- **Stop**: Run `stele check` + `pytest tests/contract/`; block session if failures
- **SessionStart/UserPromptSubmit**: Inject contract context into session
- **PostToolUse**: Record material source edits for maintenance review
