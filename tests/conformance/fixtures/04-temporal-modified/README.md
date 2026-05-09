# Fixture 04: temporal-modified

**Purpose**: validate the temporal `(modified ...)` and `(when ...)` guards
plus `state-before` / `state-after` plumbing in `stele_context`.

**CDL features exercised**:

- `(when (modified (path ...)))` — guard that only runs the assertion when a
  path's value has changed between snapshots
- `state-before` / `state-after` keys in `stele_context` consumed by
  `stele_is_modified` runtime helper
- Arithmetic operator `(sub ...)` on path values
- A second always-on invariant to ensure the suite runs both modified-guarded
  and ungated tests in the same fixture

**Why this fixture**: temporal guards demand that all backends agree on
"modified" semantics — equality of `state-before[path]` and
`state-after[path]`. If a backend's interpretation differs (e.g. treating
missing keys as "modified"), the resulting per-invariant pass/fail will not
match the canonical Python output.
