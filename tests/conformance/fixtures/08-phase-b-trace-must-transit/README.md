# Fixture 08: phase-b-trace-must-transit (Round 3 P0-9)

**Purpose**: cross-backend conformance for the Phase B Trace-Based Policy
mechanism. A controller calls `Database.query` directly without going through
`Repository`; the trace evaluator must surface a `missing_transit` violation
at error severity.

**Mechanism exercised**: `(trace-policy ...)` + `(must-transit ...)`.

**Backends**: TypeScript only today. The runner skips this fixture on
non-TypeScript backends because the call-graph extractor for Python / Go /
Java / Rust has not been implemented yet. (See `requiresPhaseB` in
`tests/conformance/types.ts`.)

When language adapters land, copy this fixture's `src/` and `contract/` to
the relevant per-language fixture form (Python: `src/*.py`, Go: `src/*.go`,
etc.) and verify the same expected violation surfaces — that's the
cross-language consistency guarantee Phase B promises.
