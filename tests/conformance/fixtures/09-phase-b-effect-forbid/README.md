# Fixture 09: phase-b-effect-forbid (Round 3 P0-9)

**Purpose**: cross-backend conformance for the Phase B Effect System. A UI
component `UserCard` transitively calls `findUser`, which is annotated with
the `db.read` effect; the `NO_IO_IN_UI` policy forbids `db.read` inside
`src/components/**`. The effect evaluator must emit one
`effect.NO_IO_IN_UI.forbidden_effect` at error severity, with the
propagation chain naming `findUser` as the propagation root.

**Mechanism exercised**: `(effect-declarations ...)`, `(effect-annotation
...)`, `(effect-policy ...)` with `(forbid ...)` + propagation through the
call graph.

**Backends**: TypeScript only today. The runner skips this fixture on
non-TypeScript backends (see `requiresPhaseB` in
`tests/conformance/types.ts`).

When language adapters land, mirror this fixture's `src/components/` and
`src/db.ts` in each language (Python/Go/Java/Rust) and verify the same
expected violation surfaces — this is the cross-language consistency
guarantee for the Effect System.
