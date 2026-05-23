# Stele — Contracts Your AI Agent Can't Break

**AI agents write code. Stele makes sure they can't break your rules.**

Stele is a contract management framework that protects your project's business invariants from AI-assisted code changes. It works by combining three layers:

1. **Write contracts in a simple DSL** (`.stele` files) that declare what must always be true
2. **Generate tests from those contracts** — deterministically, reproducibly
3. **Block the agent from editing protected files** — at the editor level, in Claude Code

An agent can write code, refactor, add features — but it physically cannot violate the contracts you've locked down. Not because it promises to behave, but because the tooling won't let it.

```
Agent writes code  →  Generated contract tests run  →  Stele verifies integrity  →  Pass or block
```

|  | |
|---|---|
| **Contracts** | Declared in [CDL](docs/spec/cdl.md), a small S-expression DSL — 70+ built-in operators |
| **Backends** | Python (pytest), TypeScript (vitest), Go, Rust, Java (JUnit 5) |
| **Integration** | Claude Code plugin with pre/post hooks, subagents, slash commands |
| **Security** | SHA-256 manifest locking, path-traversal protection, agent-edit interception |
| **License** | [MIT](LICENSE) |

---

## Why

AI agents are productive but unreliable. They:

- Don't know your project's implicit business rules
- Fix one bug and silently break another invariant
- Regenerate or "clean up" code in ways that change behavior

Stele adds structure where discipline can't: **contracts the agent can read, tests it must pass, and files it cannot edit.**

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│ Editor Hooks (Claude Code)                                   │
│  Blocks writes to protected paths · Runs checks on exit      │
└──────────────────────────────────────────────────────────────┘
                            │
┌──────────────────────────────────────────────────────────────┐
│ CLI  (init · generate · check · lock)                        │
│  Human & agent interface                                     │
└──────────────────────────────────────────────────────────────┘
                            │
┌──────────────────────────────────────────────────────────────┐
│ Core Engine (pure, deterministic)                            │
│  lexer → parser → validator → normalizer → manifest → report │
└──────────────────────────────────────────────────────────────┘
                            │
┌──────────────────────────────────────────────────────────────┐
│ Language Backends                                            │
│  Python  ·  TypeScript  ·  Go  ·  Rust  ·  Java             │
└──────────────────────────────────────────────────────────────┘
```

## Quickstart

### Install

```bash
npm install --save-dev @stele/cli
```

### Initialize

```bash
# Python + pytest
npx stele init --language python

# TypeScript + vitest
npx stele init --language typescript

# Go
npx stele init --language go

# Rust
npx stele init --language rust

# Java + JUnit 5
npx stele init --language java
```

This creates `contract/main.stele` (your contracts) and `tests/contract/` (generated tests).

### Write Your First Contract

In `contract/main.stele`:

```lisp
(invariant ORDER_TOTAL_IS_POSITIVE
  (severity high)
  (description "Order total must be positive after taxes are applied.")
  (assert (gt (path order total-with-tax) 0)))
```

### Wire Your Data

In `tests/contract/conftest.py`:

```python
@pytest.fixture
def stele_context():
    return {
        "order": load_sample_order(),  # your application state
        "_stele_checkers": {},
    }
```

Stele reads whatever your fixture returns — it doesn't invent objects.

### Generate, Run, Lock

```bash
npx stele generate               # generate tests from CDL
python -m pytest tests/contract  # run the tests
npx stele lock                   # lock SHA-256 hashes of protected files
```

### Verify (CI or local)

```bash
npx stele check     # exit 0 = clean, 2 = drift, 3 = tamper
```

## A Real Contract Example

```lisp
; contract/main.stele

(metadata
  (stele-version "0.1")
  (project "my-service"))

; --- checkers ---

(checker validate-email
  (description "Validate email format using custom Python checker."))

; --- invariants ---

(invariant USER_EMAIL_MUST_BE_VALID
  (severity error)
  (description "All user emails must match the service email pattern.")
  (uses-checker validate-email))

(invariant ACCOUNT_BALANCE_NON_NEGATIVE
  (severity error)
  (description "Account balance must never go below zero.")
  (assert (gte (path account balance) 0)))

(invariant ORDERS_HAVE_AT_LEAST_ONE_ITEM
  (severity warning)
  (description "An order must contain at least one line item.")
  (assert (not (is-empty (path order items)))))

(invariant USER_STATUS_ENUM
  (severity error)
  (description "User status must be one of the defined states.")
  (assert (in (path user status) ["active" "suspended" "deleted"])))
```

## CDL — The Contract Definition Language

CDL is a small S-expression language. No indentation rules, no braces, no boilerplate.

```lisp
; Comment (starts with ;)
(invariant NAME
  (severity error)           ; error or warning
  (description "...")
  (assert (gt (path x y) 0)))

; Collections
(assert (forall :item (collection orders)
               (gt (path :item total) 0)))

; Logic
(assert (and
  (eq (path user role) "admin")
  (not-null (path user mfa-secret))))
```

**70+ operators**: comparison (`eq`, `gt`, `gte`, `lt`, `lte`), arithmetic (`add`, `sub`, `mul`, `div`, `sum`, `avg`), logic (`and`, `or`, `not`, `implies`, `iff`), collections (`where`, `forall`, `exists`, `unique`, `distinct`, `map`, `sort-by`), strings (`matches`, `contains`, `starts-with`, `ends-with`), and more.

Full spec: [`docs/spec/cdl.md`](docs/spec/cdl.md)

## Claude Code Integration

`@stele/claude-code-plugin` adds editor-level enforcement:

| Hook | What It Does |
|------|-------------|
| **PreToolUse** | Blocks direct writes to contract files, generated tests, and manifest |
| **Stop** | Runs `stele check` + contract tests before the session ends |
| **SessionStart** | Injects contract context so the agent knows the rules |
| **PostToolUse** | Records source edits for maintenance review |

**Slash commands**: `/stele:check`, `/stele:rules`, `/stele:context`, `/stele:why`, `/stele:explain`, `/stele:maintain`

**Subagents**: `contract-author` (write new contracts), `contract-fixer` (fix violations), `contract-reviewer` (review changes)

Setup: [`docs/guides/claude-code-plugin.md`](docs/guides/claude-code-plugin.md)

## CLI Commands

```
Human commands
  stele init --language <lang>     Scaffold contract/ and tests/contract/
  stele generate [--force]         Regenerate test suite from CDL
  stele check [--diff-from main]   Verify generated drift, manifest integrity
  stele lock --reason "..."        Snapshot SHA-256 hashes of protected files
  stele unlock                     Temporarily unlock protected paths
  stele baseline-init              Suppress known legacy violations
  stele add-checker <id>           Scaffold a Python custom checker

Agent commands (read-only or append-only)
  stele rules --json               List all contract rules
  stele agent-context --focus <f>  Get focused contract context
  stele explain <id>               Explain a rule or violation
  stele why <fingerprint>          Show why a violation was suppressed
  stele propose invariant --apply  Append new invariant (never modifies existing rules)

Reference
  stele doc <topic>                Show CDL documentation
  stele list                       List invariants, checkers, groups
  stele dev                        Developer mode helpers
```

## CI Integration

Add this to your CI workflow:

```yaml
- name: Verify contracts
  run: |
    npx stele generate
    python -m pytest tests/contract -q
    npx stele check
```

`stele check` exit codes:

| Code | Meaning |
|------|---------|
| `0` | Clean — all contracts satisfied |
| `2` | Generated drift — tests don't match CDL |
| `3` | Tamper detected — manifest hashes don't match |

For focused branch checks, scope to your changes:

```bash
npx stele check --diff-from main  # only report violations in changed files
```

## Supported Languages

| Language | Test Framework | Status |
|----------|---------------|--------|
| Python | pytest | Stable |
| TypeScript | vitest | Stable |
| Go | testing | Stable |
| Rust | cargo test | Stable |
| Java | JUnit 5 | Stable |

## Self-Protection

Stele protects itself. The project's `contract/main.stele` contains **35+ invariants** (see `stele list` for the live count) that verify:

- Backend registry integrity (all 5 languages present)
- Operator registry (70+ operators, consistent specs)
- Exit code alignment with spec (all 8 codes: 0/1/2/3/4/5/6/99)
- Manifest hashing algorithm (SHA-256 enforced)
- Type system stability (9 structural types)
- Hook security (fail-closed, complete registration)
- Version synchronization across packages
- No hardcoded secrets in source

The contract is verified by the same toolchain. Every commit is checked.

## Packages

| Package | Purpose |
|---------|---------|
| `@stele/core` | Lexer, parser, validator, normalizer, registry, manifest, generator coordinator |
| `@stele/backend-python` | CDL → pytest translator + Python runtime |
| `@stele/backend-typescript` | CDL → vitest translator |
| `@stele/backend-go` | CDL → Go testing translator |
| `@stele/backend-rust` | CDL → cargo test translator |
| `@stele/backend-java` | CDL → JUnit 5 translator |
| `@stele/cli` | The `stele` executable |
| `@stele/claude-code-plugin` | Claude Code hooks, commands, subagents, skills |

## Documentation

| Topic | Link |
|-------|------|
| Architecture | [`docs/architecture.md`](docs/architecture.md) |
| CDL Language Spec | [`docs/spec/cdl.md`](docs/spec/cdl.md) |
| Python Integration Guide | [`docs/guides/python-integration.md`](docs/guides/python-integration.md) |
| Claude Code Plugin | [`docs/guides/claude-code-plugin.md`](docs/guides/claude-code-plugin.md) |
| Contributing | [`docs/contributing/`](docs/contributing/) |
| Roadmap & Strategy | [`docs/strategy/`](docs/strategy/) |

## Development

```bash
pnpm install
pnpm build                    # build all packages
pnpm test                     # run tests across all packages
pnpm typecheck                # TypeScript type checking
pnpm test:packed-adoption     # full end-to-end adoption verification
```

See [`docs/contributing/development.md`](docs/contributing/development.md) for conventions and [`docs/contributing/release.md`](docs/contributing/release.md) for the release process.

## License

[MIT](LICENSE)
