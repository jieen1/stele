# @stele/type-driven-evaluator

Type-driven evaluators for Stele contracts. This package houses the
checkers that enforce type-system-level invariants in TypeScript
projects: branded IDs (Phase A), smart constructors (Phase A),
type-state (Phase B), and effect tracking (Phase B).

The evaluators consume a parsed Stele `Contract` (from `@stele/core`)
plus a project's `tsconfig.json`, and emit `Violation` records with
deterministic `rule_id` strings of the shape
`typedriven.<form>.<id>[.<violation_kind>]`. Rule IDs are part of the
user-facing contract — once issued, they MUST remain byte-stable so
existing baselines and suppressions continue to apply.
