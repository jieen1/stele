# Fixture 01: simple-invariant

**Purpose**: smoke test — a single invariant exercising the most basic CDL
surface, used as the entry-point conformance check for every backend.

**CDL features exercised**:

- `(invariant ...)` top-level declaration
- `(assert ...)` expression
- `(eq ...)` comparison
- `(path ...)` access

**Why this fixture**: any backend must produce a passing report on this fixture
before more complex tests run. The expected report is `ok: true` with zero
violations; deviations indicate a backend cannot handle even the smallest
contract surface.
