# Fixture 05: baseline-suppression

**Purpose**: validate baseline file plumbing — `contract/.baseline.json` must
flow through `stele check` without introducing protected-file drift, and the
report must reflect zero violations when no rule has been pinned.

**CDL features exercised**:

- Two ordinary invariants (`(assert ...)` + `(path ...)` + `(gte ...)` /
  `(not-null ...)`)
- `contract/.baseline.json` shipped alongside the contract — the runner adds
  it to `protected` so manifest verification picks it up
- `filterViolationReport` baseline integration (current report is empty, so
  baseline acts as a passthrough — but the file shape, manifest hashing, and
  schema must round-trip)

**Why this fixture**: backends are responsible for emitting tests, but the
baseline pipeline lives entirely in the CLI. This fixture asserts that the
CLI consumes a hand-authored baseline file deterministically across backends
even when the report is clean. EP07 will extend this fixture with a shipped
"new violation" entry that the baseline DOES suppress; that requires
per-invariant violation emission which v0.2 has not yet shipped.
