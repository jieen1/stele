# Stele Quickstart — Python

A complete, clone-able demo of Stele protecting a tiny e-commerce app.

The app (`app/`) is a minimal Python domain model (`Order`, `Item`, `User`).
The contract (`contract/main.stele`) declares five business invariants that
`stele generate` turns into pytest tests. An AI agent that tries to break a
rule will be caught by `stele check` before its change lands.

## Structure

```
quickstart-python/
  app/
    domain.py        ← Order, Item, User dataclasses
    fixtures.py      ← sample data for contract tests
  contract/
    main.stele       ← 5 invariants (see below)
    checker_impls/
      validate_sku.py    ← custom SKU format checker
      validate_email.py  ← custom email format checker
  tests/
    contract/
      conftest.py    ← wires domain objects into Stele fixture
      test_contract.py        ← generated (do not edit)
      _stele_runtime.py       ← generated (do not edit)
  stele.config.json
  pyproject.toml
  package.json
```

## Five contracts

| ID | Severity | Description |
|---|---|---|
| `ORDER_TOTAL_POSITIVE` | error | Every order total must be > 0 |
| `ORDER_ID_PRESENT` | error | Every order must have a non-null ID |
| `USER_STATUS_ENUM` | error | User status must be active/suspended/deleted |
| `SKU_FORMAT` | warning | All SKUs match `^[A-Z]+-[A-Z0-9]+$` (custom checker) |
| `EMAIL_FORMAT` | warning | User email is RFC-shaped (custom checker) |

## Quickstart

### Prerequisites

- Node.js 18+ and npm (for Stele CLI)
- Python 3.10+ and pip

### 1. Get the code

Clone the Stele repo and navigate here, or copy this directory standalone:

```bash
git clone https://github.com/stele-team/stele
cd stele/examples/quickstart-python
```

### 2. Install Stele CLI

While Stele is pre-release, install from local tarballs:

```bash
# From the Stele repo root, pack the tarballs first:
#   pnpm build && pnpm pack -r --pack-destination local-packages/
# Then install them here:
npm install --save-dev ../../local-packages/@stele-cli-*.tgz
```

After Stele publishes to npm, you can use:

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
```

### 3. Install Python dependencies

```bash
pip install pytest
# or: python -m pip install -r requirements.txt (if you add one)
```

### 4. Generate contract tests

```bash
npx stele generate
```

This reads `contract/main.stele` and writes `tests/contract/test_contract.py`
and `tests/contract/_stele_runtime.py`. The generated files are already
committed in this example, so this step is optional on first run.

### 5. Run the tests

```bash
python -m pytest tests/contract -q
```

Expected output:

```
.....
5 passed in 0.02s
```

### 6. Break an invariant and see it caught

Edit `app/domain.py` so a `User` can have a bogus status, then wire it in
`app/fixtures.py`:

```python
# app/fixtures.py — change sample_user() to:
def sample_user() -> User:
    return User(id="usr-001", email="alice@example.com", status="superuser")
```

Re-run the tests:

```bash
python -m pytest tests/contract -q
```

You should see `test_USER_STATUS_ENUM` fail:

```
FAILED tests/contract/test_contract.py::test_USER_STATUS_ENUM
AssertionError: assert False
```

Restore `status="active"` to go back to green.

### 7. (Optional) Activate Claude Code hooks

If you use Claude Code, install the protection plugin so the agent cannot
directly edit `contract/main.stele` or the generated tests:

```bash
npx stele plugin install --claude-code
```

See `../../packages/claude-code-plugin/README.md` for full setup instructions.

## Adding your own invariants

1. Edit `contract/main.stele` — add a new `(invariant ...)` block.
2. Run `npx stele generate` to regenerate the tests.
3. Update `tests/contract/conftest.py` so `stele_context` includes the data the new invariant reads.
4. Run `python -m pytest tests/contract -q` to verify.
5. Run `npx stele lock --reason "added invariant"` to snapshot the manifest.
6. Run `npx stele check` — exit 0 means everything is clean.

## Custom checkers

`contract/checker_impls/validate_sku.py` and `validate_email.py` demonstrate
the checker pattern. Each checker:

- Is a plain Python file with a `check(stele_context, **kwargs) -> dict` function.
- Returns `{"passed": bool, "message": str | None}`.
- Is registered in `conftest.py` via `"_stele_checkers"`.

Use `npx stele add-checker <id>` to scaffold a new checker from the CLI.
