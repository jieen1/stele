# Stele Python App Integration

Stele is meant to attach to an existing Python application, not replace its domain model. Your application owns the runtime state through a `pytest` fixture named `stele_context`; generated Stele tests read that real state and never synthesize fake business objects on your behalf.

## Install and adopt

Until the npm packages are publicly published, the supported external-adoption path is the packed tarball workflow verified in this repository by `pnpm test:packed-adoption`:

```bash
npm install --save-dev /absolute/path/to/stele-core-0.1.0.tgz /absolute/path/to/stele-backend-python-0.1.0.tgz /absolute/path/to/stele-cli-0.1.0.tgz
python -m pytest --version
npx stele init --language python
```

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
npx stele add-checker balance_change_has_transaction
```

That command does two things:

1. creates `contract/checker_impls/balance_change_has_transaction.py`
2. prints the matching `(checker ...)` CDL block to stdout

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

In v0.1, `uses-checker` arguments are parsed but the Python backend rejects checker arguments during generation. Checker-backed invariants must therefore use `uses-checker <checker-id>` without extra arguments.

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

Python cache artifacts such as `.pyc`, `.pyo`, and `__pycache__` are intentionally ignored by Stele's protection logic.

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

CI should mirror the local sequence:

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

Pre-publish installation is real and continuously verified, but it is still tarball-based. The automation currently proves that a fresh Python app can install the packed `@stele/core`, `@stele/backend-python`, and `@stele/cli` tarballs together, initialize, generate, run pytest, and pass `stele check`.

The Claude Code plugin is editor-hosted, so its registration flow is documented separately in [plugin-guide.md](plugin-guide.md) rather than included in the tarball adoption script.
