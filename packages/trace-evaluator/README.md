# @stele/trace-evaluator

Phase B trace-policy evaluator: turns `TracePolicyDeclaration[]` (from `@stele/core`)
plus a `CallGraph` (from a `@stele/backend-*` extractor) into a deterministic stream
of `Violation[]`.

The evaluator enumerates call paths from each scoped caller to each pattern-matched
target (bounded by a depth and path-count cap per Round 2 D-CG-2 / MC-8), then checks
each of the five trace constraints — `must-transit`, `must-be-preceded-by`,
`must-be-followed-by`, `deny-direct`, `deny-transit` — against either the path or
the call-site sibling ordering inside the caller's body. Resulting violations are
annotated with the Phase B Round 2 `priority` / `group_id` / `also_violates` /
`cross_rule_note` fields so agents can plan a unified fix across rules.
