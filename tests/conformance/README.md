# Conformance Test Suite

Cross-backend acceptance tests for the Stele monorepo. The suite ensures that
every `LanguageBackend` (Python today; TypeScript and Go later) emits a
**structurally equivalent** `ViolationReport` for the same CDL fixture.

> Background: see `docs/design/phase-0/04-conformance-suite.md`.

## How it runs

```sh
# default (Python only)
pnpm test:conformance

# add backends by language:framework, comma-separated
STELE_CONFORMANCE_BACKENDS=python:pytest,typescript:vitest pnpm test:conformance
```

Per fixture × backend pair, the runner:

1. Copies `<fixture>/contract` and `<fixture>/stele.config.json` into a tmpdir.
2. Injects `targetLanguage` / `testFramework` into the config.
3. Runs `stele generate --force` to materialize backend-specific tests.
4. Calls `LanguageBackend.writeFixtureBootstrap(fixture, tmpdir)` so the
   backend can drop a `conftest.py` / `conftest.ts` / `setup_test.go` populated
   from `app-state.json`.
5. Runs the backend's test runner (e.g. `python3 -m pytest tests/contract`).
   If the runner is unavailable (e.g. pytest not installed), the case is
   **skipped** with a clear reason; verification of `expected-violations.json`
   is preserved as a structural shape check only.
6. Runs `stele check --json` to capture the drift report.
7. Compares the merged `ViolationReport` against
   `<fixture>/expected-violations.json` via `assertViolationReportsEqual`.

## Fixture layout

```
fixtures/
  <id>/
    README.md                    -- what's tested + why
    contract/
      main.stele                 -- CDL source
      checker_impls/<f>.py       -- optional checker implementations
    stele.config.json            -- WITHOUT targetLanguage/testFramework
    app-state.json               -- input data (becomes stele_context)
    expected-violations.json     -- ViolationReport-shaped truth
```

`expected-violations.json` follows `docs/spec/cli-output.md §2`. Field naming
matches the **real** schema:

| Field            | Notes                                              |
| ---------------- | -------------------------------------------------- |
| `rule_id`        | NOT `invariant_id`                                 |
| `rule_kind`      | `"invariant"` / `"generated_drift"` / etc.         |
| `location.path`  | NOT `location.file`                                |
| `cause.summary`  | required, single line                              |
| `cause.detail`   | string (NOT object); free-form, comparator ignores |
| `failure_witness`| see EP07; comparator does structural check         |

## Adding a new fixture

1. `mkdir tests/conformance/fixtures/06-<short-name>/contract`
2. Author `main.stele` using the smallest CDL surface that exercises the
   feature you intend to verify. Run `stele generate` against it locally to
   confirm parsing.
3. Write `app-state.json` (the data the generated test will assert against).
4. Write `stele.config.json` with `contractDir`, `entry`,
   `generatedDir`, `manifestPath`, `protected`, and `pathMode` only — leave
   `targetLanguage` / `testFramework` out so the runner injects them.
5. Run `stele check --json --report-file expected-violations.json` against a
   scratch project that mirrors the fixture, then trim/edit the result so it
   reflects only what the runner should compare.
6. Write `README.md` (one paragraph): what's tested + why.
7. Run `pnpm test:conformance`. The case must pass on Python; cases that
   require `LanguageBackend.writeFixtureBootstrap` extension on other backends
   should set `requiresCodeShape: true` in the fixture descriptor (TODO: move
   this to fixture metadata once the second backend lands).

## Comparator semantics

`comparators.ts` exports `assertViolationReportsEqual(actual, expected, options)`.

Default options ignore fields that legitimately differ across backends:

| Option                 | Default | Reason                                |
| ---------------------- | ------- | ------------------------------------- |
| `tolerance`            | `1e-9`  | IEEE-754 double comparison            |
| `ignoreLocationPath`   | `true`  | Different backends emit different paths |
| `ignoreLocationLine`   | `true`  | Line numbers differ across backends   |
| `ignoreCauseDetailText`| `true`  | Wording differs across backends       |
| `ignoreFingerprint`    | `true`  | Fingerprint depends on path           |

Always compared:

- `summary.violation_count` and `summary.active_violation_count`
- `violations[].rule_id` / `rule_kind` / `severity`
- `violations[].scope_paths` (unique-sorted)
- `violations[].cause.summary`
- `violations[].cause.failure_witness` structural shape (numbers within tolerance)

## Skipping rules

The only allowed skip path is **"runner unavailable"** (e.g. pytest not
installed in this env). Skipping for any other reason is a violation of the
suite contract; raise a follow-up task in `docs/design/phase-0/04-conformance-suite.md`
instead.
