# Stele

Stele is a production contract tool for AI-assisted software delivery. It lives inside an existing application repository, turns contract rules into generated test artifacts, and fails local or CI workflows when protected contract state drifts.

This monorepo currently publishes four packages:

- `@stele/core`
- `@stele/backend-python`
- `@stele/cli`
- `@stele/claude-code-plugin`

The v0.1 runtime target is existing Python applications that already use `pytest`.

## Quickstart

Until the packages are publicly published, the supported external-adoption path is the same tarball workflow verified by this repository's `test:packed-adoption` check: install the packed `@stele/core`, `@stele/backend-python`, and `@stele/cli` tarballs into your Python app repository.

```bash
npm install --save-dev /absolute/path/to/stele-core-0.1.0.tgz /absolute/path/to/stele-backend-python-0.1.0.tgz /absolute/path/to/stele-cli-0.1.0.tgz
python -m pytest --version
npx stele init --language python
```

That creates:

- `stele.config.json`
- `contract/main.stele`
- `contract/checker_impls/.gitkeep`
- `tests/contract/conftest.py`

Wire `tests/contract/conftest.py` to your real application state through a `stele_context` fixture, then replace the example invariant with your first contract rule. A minimal first rule looks like this:

```lisp
(invariant ACCOUNT_IS_ACTIVE
  (severity high)
  (description "The account admitted to this contract remains active.")
  (assert (eq (path account status) "active")))
```

Generate the pytest suite, run it, and lock the protected state:

```bash
npx stele generate
python -m pytest tests/contract -q
npx stele lock --reason "initial contract baseline"
npx stele check
```

## First Python app integration

Stele does not invent fake runtime objects. Generated tests read whatever your application returns from `stele_context`.

```python
import pytest


@pytest.fixture
def stele_context():
    return {
        "account": real_account_snapshot(),
        "positions": load_open_positions(),
        "_stele_checkers": {},
    }
```

If you use temporal helpers such as `(modified (path account balance))`, expose both snapshots:

```python
@pytest.fixture
def stele_context():
    return {
        "account": real_account_snapshot(),
        "positions": load_open_positions(),
        "state-before": {"account": {"balance": 4800}},
        "state-after": {"account": {"balance": 5000}},
        "_stele_checkers": {},
    }
```

The generated directory is `tests/contract/`. `conftest.py` stays application-owned; Stele manages the generated test modules and runtime helper.

## Checker-backed rules

If an invariant needs custom Python logic, scaffold a checker implementation:

```bash
npx stele add-checker balance-change-has-transaction
```

That command creates `contract/checker_impls/balance_change_has_transaction.py` and prints the matching CDL block with the canonical checker id `(checker balance-change-has-transaction ...)` to paste into your contract source. Register the approved implementation inside `stele_context["_stele_checkers"]` under the same hyphenated id, regenerate, rerun pytest, refresh the lock, and finish with `stele check`.

## CI

For ordinary verification CI on an already locked repository, run:

```bash
npx stele generate
python -m pytest tests/contract -q
npx stele check
```

When you are bootstrapping a repository or approving a contract change, insert `npx stele lock --reason "..."` between pytest and `stele check`. `stele check` is the enforcement step. It exits `2` when generated files drift and `3` when the protected manifest or protected file set is out of date.

## Claude Code plugin

`@stele/claude-code-plugin` adds editor-side guardrails:

- blocks direct edits to protected contract and generated-test paths
- runs `stele check` in the `Stop` hook before the agent finishes
- documents `/stele:init`, `/stele:check`, `/stele:add`, and `/stele:explain`
- ships a `contract-author` subagent and `contract-aware-coding` skill

For production usage details, see:

- [docs/cdl-spec.md](docs/cdl-spec.md)
- [docs/app-integration-guide.md](docs/app-integration-guide.md)
- [docs/plugin-guide.md](docs/plugin-guide.md)
