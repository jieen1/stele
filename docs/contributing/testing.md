# Testing

How Stele is tested, what each suite covers, and how to extend the test surface.

## Test stack

| Layer | Framework | Where |
| --- | --- | --- |
| TypeScript packages | [Vitest](https://vitest.dev) | `packages/<pkg>/tests/*.test.ts` |
| Python runtime | pytest | `packages/backend-python/tests/test_runtime.py` |
| End-to-end packed adoption | Node.js script | `scripts/verify-packed-adoption.mjs` |

There is no separate `coverage` configuration file — coverage assessment is performed by reading tests and source side by side. The [internal coverage gap report](../internal/test-coverage-gap-report.md) is a snapshot from 2026-05-08 with prioritized remediation tasks.

## Suites

### `@stele/core`

20 test files under `packages/core/tests/`, mirroring the source layout: `lexer/`, `parser/`, `loader/`, `validator/` (7 files), `normalizer/` (2 files), `generator`, `manifest/`, `baseline/` (2 files), `registry/`, `report/` (2 files), `errors/`.

Run:

```bash
pnpm --filter @stele/core test
```

This is the densest suite and catches the majority of regressions before they reach the CLI integration tests.

### `@stele/cli`

11 test files under `packages/cli/tests/`. Two large integration suites do most of the lifting:

- `cli.test.ts` (~43 KB) — exercises the CLI end-to-end against scratch fixtures.
- `commands.test.ts` (~29 KB) — per-command behavioral coverage.

Plus focused suites for `add-checker`, `baseline`, `code-shape` (2 files), `config`, and an end-to-end workflow test.

Run:

```bash
pnpm --filter @stele/cli test
```

### `@stele/backend-python`

Two suites that must move together:

- `tests/translator.test.ts` (~28 KB) — TypeScript translation of every supported CDL form into pytest source.
- `tests/test_runtime.py` (~28 KB) — Python runtime helper behavior (operator semantics, fixture handling, error paths).

Run:

```bash
pnpm --filter @stele/backend-python test
```

The TS test runs under vitest. The Python test runs under pytest and is invoked from the package's `test` script.

### `@stele/claude-code-plugin`

6 test files under `packages/claude-code-plugin/tests/` covering hook configuration, lifecycle context, observation hook (2 files), pre-tool-protect, and stop-validate. These tests simulate Claude Code tool calls and assert that hooks deny or allow correctly. They are the only safety net for the agent-protection layer — do not weaken them.

Run:

```bash
pnpm --filter @stele/claude-code-plugin test
```

### Packed adoption

`scripts/verify-packed-adoption.mjs` is the strongest correctness signal we have:

1. Builds and packs every workspace package into `local-packages/*.tgz`.
2. Copies the internal `fixtures/python-app/` into a temp dir.
3. Installs the tarballs into the temp app.
4. Runs `stele init`, edits the example contract, runs `stele generate`, runs pytest, runs `stele lock`, runs `stele check`.
5. Verifies that `workspace:*` did not leak into the packed manifests.

Run before merging anything that touches `@stele/core`, `@stele/backend-python`, or `@stele/cli`:

```bash
pnpm test:packed-adoption
```

## When to run what

| You touched … | Minimum suite | Recommended |
| --- | --- | --- |
| `@stele/core` | core test | core + backend-python + packed-adoption |
| `@stele/backend-python` (TS) | backend-python test | backend-python + packed-adoption |
| `@stele/backend-python` (Python runtime) | backend-python test | same |
| A CLI command | cli test | cli + packed-adoption |
| Plugin hook script | claude-code-plugin test | same |
| Slash command, subagent, skill | claude-code-plugin test | manual smoke through Claude Code |
| `scripts/*.mjs` | none automated | run the script with `--dry-run` |
| Documentation | none | check renders + relative links |

## Writing tests

- **Vitest:** prefer `describe` + `it` blocks that mirror the source's exported surface. Reach into private internals only when there is no equivalent public-API path.
- **Fixtures:** use `fixtures/python-app/` for any cross-package scenario. Don't create a parallel scratch fixture.
- **Determinism:** if a test is order-dependent, sort the inputs. Don't add retries — the bug is in the production code.
- **Path safety:** when a test exercises file IO, run it through `tmp` directories scoped to the test, never against repo paths.
- **Hook fail-closed:** every hook script test should include a "throw on input X → hook denies" case. Silent allowance on error is the most dangerous failure mode.

## Coverage gaps to be aware of

Per the [internal coverage gap report](../internal/test-coverage-gap-report.md) (2026-05-08):

- `@stele/core/src/errors/SteleError.ts` and `@stele/core/src/baseline/io.ts` had zero unit tests at the time of the audit.
- `@stele/core/src/validator/structure.ts` (large file) had thin direct coverage.
- The Python runtime helper at `_stele_runtime.py` had no Python tests at the time of the audit; `test_runtime.py` was added later.

Verify against current state before relying on these gaps for prioritization — the audit is a snapshot, not a live invariant.
