# Stele Python App Integration

Stele is meant to attach to an existing Python application, not replace its domain model. Your app owns the runtime state through a `pytest` fixture named `stele_context`; generated tests read that real state, and Stele does not invent fake application objects inside generated files.

## Install and adopt

For local or pre-publish evaluation, install the packed workspace artifacts that are automatically verified in this repository by `pnpm test:packed-adoption` and the CI workflow:

```bash
npm install --save-dev /absolute/path/to/stele-core-0.1.0.tgz /absolute/path/to/stele-backend-python-0.1.0.tgz /absolute/path/to/stele-cli-0.1.0.tgz
```

The CLI package name is currently `@stele/cli`, and its executable is `stele`. After install:

```bash
python -m pytest --version
npx stele init --language python
npx stele generate
pytest tests/contract
npx stele check
```

Your Python environment must already have `pytest` installed because Stele generates pytest suites rather than shipping its own Python test runner.

## Contract layout

Put contract sources under `contract/`:

- `contract/main.stele`: entry file referenced by `stele.config.json`
- `contract/modules/*.stele`: imported contract modules
- `contract/checker_impls/*.py`: approved checker implementations
- `contract/.manifest.json`: Stele lock manifest

Generated pytest artifacts live under `tests/contract/`.

## Application fixture contract

Your application owns `tests/contract/conftest.py` and must return the real state the contract needs:

```python
import pytest

@pytest.fixture
def stele_context():
    return {
        "account": real_account_snapshot(),
        "positions": load_open_positions(),
        "_stele_checkers": {
            "balance-change-has-transaction": approved_checker,
        },
    }
```

Treat this fixture as application code. Generated Stele tests consume it; they do not mock or synthesize your business state.

If your contract uses temporal helpers such as `(modified ...)`, expose the relevant snapshots through `stele_context["state-before"]` and `stele_context["state-after"]`.

## Checker implementations and approval

Declare checkers in `.stele` files and implement them in `contract/checker_impls/`. A generated test calls the checker through `stele_context["_stele_checkers"]`, so `conftest.py` should register approved implementations explicitly.

Recommended checker workflow:

```bash
npx stele add-checker cash_movement_matches_audit_log
```

1. Review the generated CDL checker block.
2. Add or update the matching `.stele` declaration under `contract/`.
3. Implement the Python checker in `contract/checker_impls/`.
4. Register it in `stele_context["_stele_checkers"]`.
5. Re-run `npx stele generate`, `pytest tests/contract`, and `npx stele lock --reason "approved checker update"`.

## Controlled contract changes

These paths are protected by Stele and should only change through an approved contract-change flow:

- `contract/**/*.stele`
- `contract/checker_impls/**/*`
- `contract/.manifest.json`
- `tests/contract/**/*`

That protection matters for both humans and AI agents. Agents should not directly edit those files unless the user has approved the contract change and the follow-up `stele lock`.

For an approved contract or checker change:

```bash
npx stele generate --force
pytest tests/contract
npx stele lock --reason "approved contract update"
npx stele check
```

If someone edits a generated test manually, `stele check` fails with exit code `2`. If protected contract/checker state changes without a fresh lock, `stele check` fails with exit code `3`.

## CI integration

Run Stele in CI exactly the way your repository runs it locally:

```bash
npx stele generate
pytest tests/contract
npx stele check
```

`stele check` is the enforcement step. It verifies generated files, manifest state, and locked contract/checker content without rewriting anything.
