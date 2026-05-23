# @stele/effect-evaluator

Effect-system evaluator. Takes a `Contract` (with `effectDeclarations`,
`effectAnnotations`, `effectPolicies`, `effectSuppressions`), a `CallGraph`,
and a per-backend `EffectAnnotationExtractor`; returns deterministic
`Violation[]` + advisory notices for the Phase B effect system.

The algorithm is the worklist + reverse-postorder propagation described in
`docs/design/phase-b/04-effect-system.md` §five (Round 2 MC-7), with the
fail-closed handling of unresolved calls mandated by Round 2 D-CG-5 and the
A/B fix-hint pattern from Round 2 MC-15.

This package is a pure data transformer — it never touches the filesystem;
the backend extractor (T5.3+) supplies source-code annotations, the call
graph is built upstream by a `CallGraphExtractor`, and CDL declarations are
parsed by `@stele/core`.
