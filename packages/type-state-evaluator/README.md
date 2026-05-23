# @stele/type-state-evaluator

Phase B type-state evaluator: turns `TypeStateDeclaration[]` +
`TypeStateBindingDeclaration[]` (from `@stele/core`) plus a `CallGraph` (from a
`@stele/backend-*` extractor) plus a per-backend `TypeStateInferenceExtractor`
into a deterministic stream of `Violation[]`.

The evaluator matches method-call edges in the call graph against
`(type-state ...)` declarations, asks the backend extractor for the receiver's
inferred state at each call site (TypeScript phantom-type analysis, Python
typing.Generic, Rust PhantomData, Java sealed types, Go separate-types), and
flags every call where the method is neither a transition out of nor an
allowed operation in the inferred state.

Round 2 D-CG-1: `strictMode` defaults to `true` — inference failures emit
errors (with a propose-only fix hint), not silent passes. Lenient mode emits
the same finding as a notice (severity `warning`).

Round 1 MC-15: fix-hints in this package NEVER instruct an agent to edit the
contract directly. The escape valve is always `stele design propose
--type-state <ID>`; the contract files are protected by the
`@stele/claude-code-plugin` hooks.
