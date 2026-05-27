# Stele — Contracts Your AI Agent Can't Break

**AI agents write code. Stele makes sure they can't break your rules.**

You declare business invariants in a small DSL. Stele turns them into deterministic tests, locks the contract files with SHA-256 hashes, and registers a Claude Code plugin that **physically refuses** to let the agent edit those files. Not "promises to behave" — the tooling won't allow it.

```
Agent writes code  →  Generated contract tests run  →  Stele verifies integrity  →  Pass or block
```

|  | |
|---|---|
| **Contracts** | Small S-expression DSL ([CDL](docs/spec/cdl.md)) — 70+ built-in operators |
| **Backends** | Python (pytest), TypeScript (vitest), Go, Rust, Java (JUnit 5) |
| **Integration** | Claude Code plugin with pre/post hooks, subagents, slash commands |
| **Security** | SHA-256 manifest locking, path-traversal protection, agent-edit interception |
| **License** | [MIT](LICENSE) |

---

## Quickstart — 5 commands to working contracts

> **Heads up:** v0.1 is **not yet on the public npm registry**. Step 1 uses local tarballs. After we publish, step 1 becomes `npm install --save-dev @stele/cli @stele/claude-code-plugin`.

```bash
# 1. Install Stele into your application repo
./scripts/install-stele-local.sh /path/to/your/app
cd /path/to/your/app

# 2. Scaffold contracts (--with-example-fixtures gives a working demo out-of-the-box)
npx stele init --language python --with-example-fixtures

# 3. Generate the test suite from CDL
npx stele generate

# 4. Run it — green out-of-the-box
python -m pytest tests/contract -q     # → 5 passed

# 5. Lock + verify
npx stele lock --reason "initial baseline"
npx stele check                        # → OK 5 invariants checked
```

That's it. You now have 5 contracts auto-generating 5 tests against starter data. Edit `contract/main.stele` to add your real rules; edit `tests/contract/conftest.py` to point at your real state.

---

## Install

Pick the path for your environment. All five land at the same `npx stele init` step.

### Path A — Linux / macOS bash script

```bash
# Run from your application repo, pointing at the Stele clone:
/path/to/stele/scripts/install-stele-local.sh

# Or from the Stele repo against a target app:
./scripts/install-stele-local.sh /path/to/your/app
```

### Path B — Windows PowerShell

```powershell
& 'C:\path\to\stele\local-packages\install-stele-local.ps1'
```

Both scripts:
- Pack `@stele/{core,backend-python,cli,claude-code-plugin}` if `local-packages/*.tgz` is empty
- `npm install --save-dev` all four tarballs
- Wire `npm run stele:{init,generate,lock,check,list}` shortcuts
- Verify `npx stele --version` resolves five different ways

### Path C — manual tarball install (any OS)

```bash
npm install --save-dev \
  /abs/path/stele-core-0.1.0.tgz \
  /abs/path/stele-backend-python-0.1.0.tgz \
  /abs/path/stele-cli-0.1.0.tgz \
  /abs/path/stele-claude-code-plugin-0.1.0.tgz
npx stele --version   # → 0.1.0
```

### Path D — after npm publish (future)

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

Full path matrix + troubleshooting: [`docs/guides/installation.md`](docs/guides/installation.md).

---

## Initialize

```bash
npx stele init --language <python|typescript|go|rust|java>

# Optional flags:
#   --with-example-fixtures   include working e-commerce demo (python+typescript)
#   --ci github-actions       also write .github/workflows/stele.yml
#   --ci gitlab-ci            also write .gitlab-ci.yml
#   --pre-commit              install a pre-commit hook running `stele check`
#   --dry-run                 print files without writing them
```

### What gets created

```
your-app/
├── stele.config.json          ← paths, target language, protected globs
├── contract/
│   ├── main.stele             ← YOUR CONTRACTS — edit this
│   └── checker_impls/         ← custom Python/TS checkers go here
└── tests/
    └── contract/
        ├── conftest.py        ← WIRE YOUR DATA — edit this to expose app state
        └── _stele_runtime.py  ← generated; do not edit
```

### What you edit

**`contract/main.stele`** — Each `(invariant …)` becomes one test. The default scaffold ships three teaching examples (balance check, forall over collection, status enum) you delete or modify:

```lisp
(invariant ACCOUNT_BALANCE_NON_NEGATIVE
  (severity error)
  (description "Account balance must never go below zero.")
  (assert (gte (path account balance) 0)))
```

**`tests/contract/conftest.py`** — The `stele_context` fixture is the bridge between your app and the generated tests. Return whatever shape your contracts assert against:

```python
@pytest.fixture
def stele_context():
    return {
        "account": load_account_from_db(),     # your real data
        "user": load_user_from_db(),
        "orders": fetch_recent_orders(),
        "_stele_checkers": {},                 # custom checkers, if any
    }
```

Stele reads whatever your fixture returns — it doesn't invent objects.

### Verify your setup

```bash
npx stele doctor
```

Runs 10 self-checks (config, scaffold, generated drift, backend toolchain, manifest, Claude Code plugin registration, custom checker imports). Output:

```
[stele doctor]
  ✓ @stele/cli 0.1.0 resolves
  ✓ stele.config.json is valid
  ✓ contract/main.stele parses (3 invariants)
  ✓ Generated tests are in sync (no drift)
  ⚠ No contract/.manifest.json — run `stele lock --reason "initial baseline"`
  ⚠ Claude Code plugin not registered for this project
    → run `stele plugin install --claude-code` to fix

Summary: 7 OK, 2 warnings, 0 errors.
```

---

## Claude Code plugin (optional but recommended)

The plugin adds editor-level enforcement: blocks direct writes to `contract/**`, runs `stele check` on `Stop`, injects contract context at `SessionStart`.

```bash
# Activate in one command
npx stele plugin install --claude-code

# Then restart Claude Code (close + reopen)
```

| Hook | What It Does |
|---|---|
| **PreToolUse** | Blocks direct writes to contract files, generated tests, and manifest |
| **Stop** | Runs `stele check` + contract tests before the session ends |
| **SessionStart** | Injects contract context so the agent knows the rules |
| **PostToolUse** | Records source edits for maintenance review |

**Slash commands:** `/stele:check`, `/stele:rules`, `/stele:context`, `/stele:why`, `/stele:explain`, `/stele:maintain`

**Subagents:** `contract-author`, `contract-fixer`, `contract-reviewer`

Manual fallback + full hook reference: [`docs/guides/claude-code-plugin.md`](docs/guides/claude-code-plugin.md).

---

## Working demos

If you'd rather see Stele working in a complete app before integrating it, clone these:

| Demo | What it shows |
|---|---|
| [`examples/quickstart-python/`](examples/quickstart-python/) | E-commerce Python app with 5 invariants + 2 custom checkers (SKU regex + email format) |
| [`examples/quickstart-typescript/`](examples/quickstart-typescript/) | Same e-commerce model in TypeScript + vitest |
| [`examples/finance-guard/`](examples/finance-guard/) | Larger finance-domain example |
| [`examples/cursor-demo/`](examples/cursor-demo/) | Cursor IDE integration sample |

---

## CDL — Contract Definition Language

Small S-expression DSL. No indentation rules, no braces, no boilerplate.

```lisp
(invariant NAME
  (severity error)           ; error or warning
  (description "...")
  (assert (gt (path x y) 0)))

; Quantify over a collection from stele_context["orders"]
(assert (forall item (collection orders)
               (gt (path item total) 0)))

; Boolean logic
(assert (and (eq (path user role) "admin")
             (not-null (path user mfa-secret))))
```

**70+ operators**: comparison (`eq` / `gt` / `gte` / `lt` / `lte`), arithmetic (`add` / `sub` / `mul` / `div` / `sum` / `avg`), logic (`and` / `or` / `not` / `implies` / `iff`), collections (`where` / `forall` / `exists` / `unique` / `distinct` / `map` / `sort-by`), strings (`matches` / `contains` / `starts-with` / `ends-with`), and more.

Full spec: [`docs/spec/cdl.md`](docs/spec/cdl.md).

---

## CLI reference

```
Setup
  stele init --language <lang>     Scaffold contract/ and tests/contract/
  stele plugin install --claude-code   Register the Claude Code plugin
  stele doctor                     Self-check: did everything install right?

Daily flow
  stele generate [--force]         Regenerate test suite from CDL
  stele check [--diff-from main]   Verify generated drift, manifest integrity
  stele lock --reason "..."        Snapshot SHA-256 hashes of protected files
  stele unlock                     Temporarily unlock protected paths
  stele baseline-init              Suppress known legacy violations
  stele add-checker <id>           Scaffold a custom checker

Agent-facing (read-only / append-only)
  stele rules --json               List all contract rules
  stele agent-context --focus <f>  Get focused contract context
  stele explain <id>               Explain a rule or violation
  stele why <fingerprint>          Show why a violation was suppressed
  stele propose invariant --apply  Append a new invariant (never modifies)

Reference
  stele doc <topic>                Show CDL documentation
  stele list                       List invariants, checkers, groups
  stele dev                        Developer mode helpers
```

---

## CI integration

```yaml
# .github/workflows/stele.yml — `stele init --ci github-actions` writes this for you
- name: Verify contracts
  run: |
    npx stele generate
    python -m pytest tests/contract -q
    npx stele check
```

| Exit code | Meaning |
|---|---|
| `0` | Clean — all contracts satisfied |
| `2` | Generated drift — committed tests don't match CDL |
| `3` | Tamper detected — manifest hashes don't match |

Focused branch check: `npx stele check --diff-from main` (only changed files).

---

## Supported languages

| Language | Phase A (`invariant`/`scenario`/`checker`) | Phase B (`trace`/`effect`/`type-state` …) | Code-shape (`class-shape`/`boundary` …) |
|---|---|---|---|
| **TypeScript** | ✅ | ✅ full | ✅ |
| **Python** | ✅ | ✅ trace + effect + architecture + core-node (Round 14); `type-state` / `branded-id` still TS-only | ✅ |
| Go | ✅ | ❌ fail-loud | ❌ |
| Rust | ✅ | ❌ fail-loud | ❌ |
| Java | ✅ | ❌ fail-loud | ❌ |

Per-language guides: [Python](docs/guides/python-integration.md) · [TypeScript](docs/guides/typescript-integration.md) · [Go](docs/guides/go-integration.md) · [Rust](docs/guides/rust-integration.md) · [Java](docs/guides/java-integration.md).

---

## Self-protection

Stele protects itself with **48 invariants** (run `stele list` for live count) using 14 of its own mechanisms — backend registry integrity, operator-spec consistency, exit code alignment, manifest hashing (SHA-256), hook fail-closed, version sync, no hardcoded secrets, and more. The contract is verified by the same toolchain on every commit. Coverage matrix: [`docs/internal/self-protection-coverage-matrix.md`](docs/internal/self-protection-coverage-matrix.md).

---

## Packages

| Package | Purpose |
|---|---|
| `@stele/core` | Lexer, parser, validator, normalizer, registry, manifest, generator coordinator |
| `@stele/cli` | The `stele` executable |
| `@stele/backend-{python,typescript,go,rust,java}` | CDL → test-framework translators + runtimes |
| `@stele/{trace,type-state,effect,type-driven}-evaluator` | Phase B static analyzers (TS source + Python where applicable) |
| `@stele/{architecture-core,call-graph-core}` | Phase B foundations |
| `@stele/agent-hooks` | Shared editor-hook SDK |
| `@stele/claude-code-plugin` | Claude Code hooks, commands, subagents, skills |
| `@stele/mcp-server` | MCP bridge for Cursor / other agents |
| `@stele/github-action` | Stele as a GitHub Action |

---

## Documentation

| Start here | |
|---|---|
| **Installation (one-page start)** | [`docs/guides/installation.md`](docs/guides/installation.md) |
| **Architecture** | [`docs/architecture.md`](docs/architecture.md) |
| **CDL spec** | [`docs/spec/cdl.md`](docs/spec/cdl.md) |
| **Claude Code plugin** | [`docs/guides/claude-code-plugin.md`](docs/guides/claude-code-plugin.md) |
| **Contributing** | [`docs/contributing/`](docs/contributing/) |
| **Roadmap & strategy** | [`docs/strategy/`](docs/strategy/) |

---

## Development (working on Stele itself)

```bash
pnpm install
pnpm build                    # build all packages
pnpm test                     # vitest in each package + python runtime tests
pnpm typecheck                # tsc --noEmit per package
pnpm test:packed-adoption     # end-to-end: pack → install fixture → init → check
```

See [`docs/contributing/development.md`](docs/contributing/development.md) for conventions and [`docs/contributing/release.md`](docs/contributing/release.md) for the release process.

---

## License

[MIT](LICENSE)
