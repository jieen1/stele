# Stele Python App Integration

Stele is meant to attach to an existing Python application, not replace its domain model. Your application owns the runtime state through a `pytest` fixture named `stele_context`; generated Stele tests read that real state and never synthesize fake business objects on your behalf.

## Install and adopt

Until the npm packages are publicly published, the supported external-adoption path is the packed tarball workflow verified in this repository by `pnpm test:packed-adoption`:

```bash
npm install --save-dev /absolute/path/to/stele-core-0.1.0.tgz /absolute/path/to/stele-backend-python-0.1.0.tgz /absolute/path/to/stele-cli-0.1.0.tgz
python -m pytest --version
npx stele init --language python
```

For local development from this repository, `local-packages/install-stele-local.ps1` installs the packed CLI, core, Python backend, and Claude Code plugin tarballs into the current application. It also writes npm scripts such as `stele:init`, `stele:generate`, `stele:lock`, and `stele:check` so operators can use `npm run stele:check` without remembering the `npx` form.

Use `npx stele --version`, `npx -- stele --version`, `npx stele version`, `npm exec -- stele --version`, or `npm run stele -- --version` to verify the CLI. Do not use `npm exec stele --version`; npm treats that as npm's own version flag.

After `stele init`, your repository has:

- `stele.config.json`
- `contract/main.stele`
- `contract/checker_impls/.gitkeep`
- `tests/contract/conftest.py`

Your Python environment must already have `pytest` installed because Stele generates pytest suites instead of shipping its own Python test runner.

## Contract layout

Stele's default repository layout is:

- `contract/main.stele`: entry file referenced by `stele.config.json`
- `contract/modules/*.stele`: imported contract modules
- `contract/checker_impls/*.py`: approved checker implementations
- `contract/.manifest.json`: protected-file lock manifest
- `tests/contract/*.py`: generated pytest modules
- `tests/contract/_stele_runtime.py`: generated runtime helper
- `tests/contract/conftest.py`: application-owned fixture wiring

The generated output directory is `tests/contract/`, but `conftest.py` remains user-owned and is allowed to live alongside the generated files.

## Scenario-backed invariants

The Python slice now supports a narrow `scenario` primitive for setup flows that must run before an invariant asserts on generated state. Scenario-backed invariants add two runtime expectations:

- the invariant uses `(uses-scenario scenario-id)`
- the generated pytest test function requires a `stele_sandbox` fixture in addition to `stele_context`

Example:

```lisp
(scenario fund-pnl-flow
  (sandbox transactional)
  (executor python-import)
  (step setup-fund
    (call "tests.contract_scenarios:create_fund"
      (body (object (name (gen unique-name "fund")))))
    (capture fund))
  (capture-state pnl
    (call "tests.contract_scenarios:get_pnl"
      (body (object (fund-id (ref fund id)))))))

(invariant FUND_PNL_VALID
  (uses-scenario fund-pnl-flow)
  (severity high)
  (description "Generated fund PnL remains valid.")
  (assert (gt (path pnl value) 0)))
```

The generated runtime imports `tests.contract_scenarios`, calls each `module:function` target as `function(body, stele_context)`, merges captured scenario state into the assertion context, and then evaluates the invariant.

## The `stele_context` fixture

Your application owns the contract runtime surface by returning a dictionary from `stele_context`:

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

Generated tests can traverse dictionaries and Python objects. The generated runtime helper resolves:

1. dictionary keys
2. object attributes
3. underscore-normalized attributes for CDL names that contain `-`

That means `(path account total-value)` can resolve either `account["total-value"]` or `account.total_value`.

### Optional or empty app data

The default `tests/contract/conftest.py` scaffold includes two small fixture helpers:

```python
def stele_default(value, fallback):
    return fallback if value is None else value


def stele_context_or_skip(**values):
    missing = sorted(name for name, value in values.items() if value is None)
    if missing:
        pytest.skip("Stele context unavailable: " + ", ".join(missing))
    return values
```

Use `stele_default` when `None` should mean an empty collection or other safe domain default:

```python
@pytest.fixture
def stele_context():
    return {
        "account": real_account_snapshot(),
        "positions": stele_default(load_open_positions(), []),
        "_stele_checkers": {},
    }
```

Use `stele_context_or_skip` when the contract cannot be evaluated responsibly without the value:

```python
@pytest.fixture
def stele_context():
    return stele_context_or_skip(
        account=real_account_snapshot(),
        positions=stele_default(load_open_positions(), []),
        _stele_checkers={},
    )
```

This keeps missing-data handling in the app-owned fixture instead of repeating `(when ...)` guards on every invariant. Use invariant-level `when` only when the condition is part of the business rule itself.

### The `stele_sandbox` fixture

Scenario-backed invariants require a `stele_sandbox` fixture. In v0.1 Stele does not create or roll back transactions itself; it only depends on this fixture so your app can do that work.

The simplest no-op shape is:

```python
from contextlib import nullcontext
import pytest


@pytest.fixture
def stele_sandbox():
    return nullcontext()
```

For real application tests, return a context manager or fixture value that starts the transactional scope your app wants around scenario execution.

## Cross-table numeric rules

For constraints that aggregate one table through a relationship to another table, keep the raw rows in `stele_context` and express the relationship in CDL with `where`:

```python
@pytest.fixture
def stele_context():
    return {
        "budgets": load_budget_rows(),
        "transactions": load_transaction_rows(),
    }
```

```lisp
(invariant BUDGETS_WITHIN_LIMIT
  (severity high)
  (description "Posted transaction totals stay inside each budget.")
  (assert
    (forall budget (collection budgets)
      (lte
        (sum
          (where txn (collection transactions)
            (eq (path txn budget-id) (path budget id)))
          (path amount))
        (path budget limit)))))
```

The same filtered collection form works with `avg`, `min`, `max`, `count`, and nested quantifiers in the Python backend. Use Python checker implementations when the rule needs domain code that is not naturally a collection filter or aggregate.

## Temporal helpers

If your contract uses temporal helpers such as `(modified (path account balance))`, expose both snapshots:

```python
@pytest.fixture
def stele_context():
    return {
        "state-before": {
            "account": {"balance": 4800},
        },
        "state-after": {
            "account": {"balance": 5000},
        },
        "_stele_checkers": {},
    }
```

`state-before` and `state-after` are runtime conventions used by the generated Python backend in v0.1.

## Writing contract source

Put contract source under `contract/` and keep all imported `.stele` files reachable from `contract/main.stele`.

Example:

```lisp
(import "./modules/account.stele")

(invariant ACCOUNT_IS_ACTIVE
  (severity high)
  (description "Brokerage accounts admitted to the contract remain active.")
  (assert (eq (path account status) "active")))
```

Imports are resolved relative to the importing file. `stele generate`, `stele check`, and `stele lock` all fail if a protected `.stele` file exists under the protected set but is not reachable from the configured entry graph.

## Checker implementations

Declare the checker in CDL and implement it in Python:

```bash
npx stele add-checker balance-change-has-transaction
```

That command does two things:

1. creates `contract/checker_impls/balance_change_has_transaction.py`
2. prints the matching `(checker balance-change-has-transaction ...)` CDL block to stdout

After that:

1. paste or add the checker declaration to a loaded `.stele` file
2. implement the Python function in `contract/checker_impls/`
3. register it in `stele_context["_stele_checkers"]`
4. regenerate and rerun tests
5. refresh the manifest lock

Example fixture registration:

```python
@pytest.fixture
def stele_context():
    return {
        "_stele_checkers": {
            "balance-change-has-transaction": approved_checker,
        },
    }
```

In v0.1, `uses-checker` arguments are parsed but the Python backend rejects checker arguments during generation. Checker-backed invariants must therefore use `uses-checker <checker-id>` without extra arguments. The canonical checker id remains hyphenated CDL text; only the Python filename is underscore-normalized.

## Generated tests

The Python backend generates:

- `tests/contract/__init__.py`
- `tests/contract/_stele_runtime.py`
- `tests/contract/test_contract.py` for top-level invariants
- `tests/contract/test_<group>.py` for each group

Stele does not want you to hand-edit those generated files. Change the contract source or checker implementation instead, then rerun generation.

## Protected files and AI editing

The default protected globs are:

- `contract/**/*.stele`
- `contract/checker_impls/**/*`
- `contract/.manifest.json`
- `tests/contract/**/*`

That protection matters for both humans and AI agents:

- do not edit generated tests by hand
- do not change contract files casually during unrelated feature work
- do not refresh the manifest lock unless the contract/checker change was explicitly approved

Python cache artifacts ending in `.pyc` or `.pyo` are intentionally ignored by Stele's protection logic. Ordinary files remain protected even when they live under a `__pycache__` directory.

## Controlled contract-change flow

When a contract change is approved, use this sequence:

```bash
npx stele generate --force
python -m pytest tests/contract -q
npx stele lock --reason "approved contract update"
npx stele check
```

Notes:

- `--force` is required when generated files intentionally change.
- `stele lock` updates `contract/.manifest.json` only after generated files are already current.
- In v0.1, `--reason` is accepted for workflow parity but is not persisted into the manifest file.

## CI

CI should mirror the local verification sequence for an already locked repository:

```bash
npx stele generate
python -m pytest tests/contract -q
npx stele check
```

`stele check` is the non-mutating enforcement step. It verifies:

- the generated pytest files still match the current contract
- the protected manifest still matches the current protected file contents
- the current contract hash still matches the locked manifest
- no new protected files were added without a fresh lock

## Packed adoption caveat

Pre-publish installation is real and continuously verified, but it is still tarball-based. The automation currently proves that a fresh Python app can install the packed `@stele/core`, `@stele/backend-python`, and `@stele/cli` tarballs together, initialize, generate, run pytest, explicitly lock the initial baseline, and then pass `stele check`.

The Claude Code plugin is editor-hosted, so its registration flow is documented separately in [plugin-guide.md](plugin-guide.md) rather than included in the tarball adoption script.
