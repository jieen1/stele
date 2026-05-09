# Fixture 03: scenario-checker

**Purpose**: validate the `(checker ...)` declaration plus
`(uses-checker ...)` invariant binding, including loading a custom checker
implementation from `contract/checker_impls/`.

**CDL features exercised**:

- `(checker <id> ...)` declaration
- `(invariant ...)` with `(uses-checker <id>)` (no inline assert)
- Custom Python checker implementation injected via `app-state.json`'s
  `_checkers` map; the conformance runner builds a `conftest.py` that loads
  it from `contract/checker_impls/<file>.py` and registers it under
  `_stele_checkers`

**Why this fixture**: backends must support delegating an invariant entirely
to a checker function. The Python backend wires this through
`stele_call_checker` at runtime; the TypeScript / Go backends will lower it
the same way once they ship. This fixture also exercises the
`writeFixtureBootstrap` extension point — different backends emit different
bootstrap shapes, but the `_checkers` declaration in `app-state.json` is
shared.
