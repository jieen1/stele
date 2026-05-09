# Fixture 06: code-shape

**Purpose**: validate EP06 Code Shape Python backend emit. The generated
`test_code_shape.py` must run real pytest assertions backed by the
`stele_resolve_class` / `stele_resolve_function` / `stele_has_field` /
`stele_has_callable` runtime helpers.

**CDL features exercised**:

- `(class-shape account_class ...)` with `must-have-field` (typed) and
  `must-have-method`
- `(function-shape calculate_total_fn ...)` with `must-have-parameter`
- One ordinary `(invariant ...)` so the runner still emits `test_contract.py`

**Why this fixture**: Code Shape is Python-only in v0.2. The runner skips
this fixture on non-Python backends via `requiresCodeShape`. The compliant
Python module under `app/` matches every shape, so `stele check` is expected
to return zero violations and pytest passes when available.

EP07 will extend this fixture with a non-compliant variant that produces
expected violations; v0.2 only ships the green-path case.
