# Stele

> Contracts carved in stone for AI-assisted software delivery.

Stele is a contract management framework for projects where AI agents write code. It turns business invariants into generated tests, locks the protected state with cryptographic hashes, and intercepts agent edits at the editor layer — so an agent **cannot** silently violate the contracts you depend on.

The v0.1 runtime targets existing Python applications that already use `pytest`.

## Why Stele

AI agents are unreliable executors. They write code confidently, but:

- They are blind to a project's implicit invariants.
- Fixing one bug often breaks another rule that nobody encoded.
- A green test suite is not a guarantee that business rules still hold.
- Discipline is not a property they have — only structure can enforce them.

Stele's answer is three layers that stack:

1. **Contracts** are declared in CDL (a tiny S-expression DSL), in files the agent physically cannot edit.
2. **Tests are generated** from the contracts, also protected. Any code change must pass them.
3. **Editor hooks** in Claude Code block direct edits to protected paths and run `stele check` before the agent finishes.

Read [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Packages

This monorepo publishes four npm packages:

| Package | Purpose |
| --- | --- |
| [`@stele/core`](packages/core) | Lexer, parser, validator, manifest, generator coordinator |
| [`@stele/backend-python`](packages/backend-python) | CDL → pytest translator and Python runtime helpers |
| [`@stele/cli`](packages/cli) | The `stele` executable used by humans, agents, and CI |
| [`@stele/claude-code-plugin`](packages/claude-code-plugin) | Hooks, slash commands, subagents, and skills for Claude Code |

## Quickstart

```bash
# 1. Install (during pre-release, install from packed tarballs)
npm install --save-dev /abs/path/stele-core-0.1.0.tgz \
                      /abs/path/stele-backend-python-0.1.0.tgz \
                      /abs/path/stele-cli-0.1.0.tgz

# 2. Initialize the contract scaffolding
npx stele init --language python

# 3. Author your first invariant in contract/main.stele
#    and wire tests/contract/conftest.py to your real app state

# 4. Generate, run, lock, and verify
npx stele generate
python -m pytest tests/contract -q
npx stele lock --reason "initial contract baseline"
npx stele check
```

After npm publishes, the install line becomes:

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

For Windows local adoption from this checkout:

```powershell
E:\project\stele\local-packages\install-stele-local.ps1
```

That installs the packed packages and writes `npm run stele:init`, `stele:generate`, `stele:lock`, and `stele:check` scripts.

A complete walkthrough — including the `stele_context` fixture, checker registration, temporal helpers, and the controlled contract-change flow — lives in [`docs/guides/python-integration.md`](docs/guides/python-integration.md).

## A first invariant

```lisp
(invariant ACCOUNT_IS_ACTIVE
  (severity high)
  (description "The account admitted to this contract remains active.")
  (assert (eq (path account status) "active")))
```

Wire your application state through the `stele_context` pytest fixture:

```python
@pytest.fixture
def stele_context():
    return {
        "account": real_account_snapshot(),
        "positions": load_open_positions(),
        "_stele_checkers": {},
    }
```

Stele does **not** invent runtime objects — generated tests read whatever your fixture returns.

## CLI surface

```bash
npx stele init        --language python    # scaffold contract/, tests/contract/
npx stele generate    [--force]            # regenerate pytest suite from CDL
npx stele check       [--diff-from main]   # verify generated drift, manifest, baseline
npx stele lock        --reason "..."       # snapshot protected SHA-256s
npx stele baseline-init                    # suppress known legacy violations
npx stele add-checker <id>                 # scaffold a Python checker
```

Agent-facing commands keep contracts understandable as the project grows:

```bash
npx stele rules --json
npx stele agent-context --focus path/to/changed_file.py
npx stele why <rule-id-or-fingerprint>
npx stele maintenance-summary --from main --output .stele/maintenance/summary.md
npx stele propose invariant --id NEW --severity medium \
    --description "..." --assert "(eq 1 1)" --apply
```

`propose` only appends to `contract/proposals/agent-additions.stele` — it never mutates locked manifests, baselines, or generated tests. Changing or deleting an existing rule remains a user-reviewed protected edit.

Full reference: [`docs/spec/cdl.md`](docs/spec/cdl.md).

## Claude Code plugin

`@stele/claude-code-plugin` adds editor-side guardrails:

- **PreToolUse** hook blocks direct writes/edits/bash to protected contract and generated-test paths.
- **SessionStart / UserPromptSubmit / PreToolUse** hooks inject focused contract context.
- **PostToolUse** hook records material source edits for later contract-maintenance review.
- **Stop** hook runs `stele check` and `pytest tests/contract` before the agent finishes.
- Slash commands: `/stele:init`, `/stele:check`, `/stele:add`, `/stele:explain`, `/stele:rules`, `/stele:context`, `/stele:why`, `/stele:maintain`.
- Subagents: `contract-author`, `contract-fixer`, `contract-reviewer`. Skills: `contract-aware-coding`, `contract-debugging`.

See [`docs/guides/claude-code-plugin.md`](docs/guides/claude-code-plugin.md).

## CI

For verification CI on a locked repository:

```bash
npx stele generate
python -m pytest tests/contract -q
npx stele check
```

`stele check` is the enforcement step:

- exit `0` — clean
- exit `2` — generated files drifted from CDL
- exit `3` — protected manifest or protected file set is out of date

For focused branch checks, scope failures to your current change set:

```bash
npx stele check --diff-from main
```

Stele compares `main...HEAD` plus staged, unstaged, and untracked files. Out-of-scope violations stay in the JSON report with `out_of_scope` status but do not block the check.

## Documentation

| Topic | Location |
| --- | --- |
| Documentation index | [`docs/README.md`](docs/README.md) |
| Architecture overview | [`docs/architecture.md`](docs/architecture.md) |
| CDL language spec | [`docs/spec/cdl.md`](docs/spec/cdl.md) |
| CLI JSON output schemas | [`docs/spec/cli-output.md`](docs/spec/cli-output.md) |
| Python app integration | [`docs/guides/python-integration.md`](docs/guides/python-integration.md) |
| Claude Code plugin | [`docs/guides/claude-code-plugin.md`](docs/guides/claude-code-plugin.md) |
| Phased plans (PRDs v2.0) | [`docs/prd-phase-0.md`](docs/prd-phase-0.md) · [`docs/prd-phase-1.md`](docs/prd-phase-1.md) · [`docs/prd-phase-2.md`](docs/prd-phase-2.md) |
| Original design doc (中文) | [`docs/design/项目设计文档.md`](docs/design/项目设计文档.md) |
| Roadmap & strategy | [`docs/strategy/`](docs/strategy/) |
| Contributing & release | [`docs/contributing/`](docs/contributing/) |

## Development

```bash
pnpm install
pnpm build           # build all workspace packages
pnpm test            # run vitest + python tests across packages
pnpm typecheck       # core/backend-python build + per-package typecheck
pnpm test:packed-adoption   # full external-adoption verification
```

The release flow is documented in [`docs/contributing/release.md`](docs/contributing/release.md). For day-to-day development conventions, see [`docs/contributing/development.md`](docs/contributing/development.md). For testing strategy and the coverage gap report, see [`docs/contributing/testing.md`](docs/contributing/testing.md).

## License

[MIT](LICENSE)
