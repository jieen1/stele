# Agent Contract Implementation Design Review

Date: 2026-05-18

Reviewed documents:

- `docs/agent-contract-system-design.md`
- `docs/design/agent-contract-implementation-design.md`

Review stance:

- Treat the implementation design as a build spec.
- Findings focus on defects, ambiguity that can cause wrong implementation, missing enforcement, and test gaps.
- Cosmetic wording is ignored.

## Review Rounds

### Round 1: Product-Scope Fit

Question: does the implementation design preserve the product premise from the source document?

Result:

- The design correctly keeps Stele focused on contract enforcement, not generic linting.
- It correctly keeps L2 as dependency-graph assertions.
- It correctly keeps L3 out of generated tests.
- It correctly avoids WebUI, fake acceptance report detection, semantic duplicate-code detection, and multi-language expansion.

Main concern:

- Some implementation shortcuts in L2 and reporting would weaken the contract-strength premise if they remain optional.

### Round 2: Engineering Feasibility

Question: can a developer implement this spec without inventing major missing decisions?

Result:

- Parser/type work is concrete.
- CLI stage integration is concrete.
- Test fixture coverage is mostly concrete.

Main concerns:

- TypeScript module resolution is underspecified for real projects.
- The shared implementation boundary between CLI and generated tests is left optional.
- Package dependency decisions are incomplete.

### Round 3: Enforcement Integrity

Question: can an agent or implementation gap weaken enforcement while tests still appear green?

Result:

- Protected-file/user-review guidance remains aligned with Stele's current philosophy.
- L3 `ideal` as non-blocking notice is correct.

Main concerns:

- Architecture violations may not participate in baseline suppression unless the current baseline eligibility model is changed.
- Contract evolution events store hashes but not before/after contract content, weakening auditability.
- Generated architecture runtime drift can silently reduce enforcement.

### Round 4: Testability

Question: can the proposed behavior be proven by tests rather than claims?

Result:

- The design contains parser, evaluator, CLI, generated-test, hook, and event tests.
- It asks for behavior assertions, not only snapshots.

Main concerns:

- Missing tests around baseline eligibility for architecture/complexity.
- Missing tests around report schema compatibility after adding `notices`.
- Missing package-adoption test for generated TypeScript architecture tests in a real consuming project.

## Findings

### P0: L2 has two possible enforcement implementations, which can break contract strength

Location:

- `docs/design/agent-contract-implementation-design.md`, section 4.8

The design says generated tests must mirror the CLI evaluator, then makes `packages/architecture-core` preferred but not mandatory. The alternative permits a vendored runtime copied from the same source template.

This is dangerous for Stele's core premise. If CLI and generated tests drift, an agent can satisfy one enforcement path while weakening another. Snapshot equivalence tests reduce risk but do not remove it, especially as architecture rules grow.

Required change:

- Make a single shared evaluator mandatory.
- Create `packages/architecture-core` in Phase 1.
- CLI and generated TypeScript tests must both call this shared package.
- Generated tests may serialize architecture declarations, but graph building and rule evaluation must come from the same implementation.

Acceptance test:

- One fixture is evaluated through CLI and generated Vitest test.
- Assert same violation count, same rule id, same `fromModule`, same `toModule`, same source file, same line.

### P0: Architecture/complexity baseline policy is undefined and conflicts with current code

Location:

- `docs/design/agent-contract-implementation-design.md`, section 4.7
- `packages/cli/src/commands/check.ts`

The design says architecture reports should apply baseline filtering. Current baseline eligibility only suppresses:

```ts
violation.source.kind === "rule" &&
violation.rule_kind === "rule_violation"
```

The proposed architecture violation uses:

```ts
source.kind = "architecture"
rule_kind = "architecture_dependency"
```

So architecture violations would not be suppressible under the current filter. That is a product decision, not a small implementation detail.

Required change:

- Explicitly define baseline eligibility:
  - L2 architecture dependency/cycle violations should be baseline-eligible for legacy adoption.
  - L3 `current > max` should not be baseline-eligible by default, unless the user explicitly opts into `baseline-complexity`.
- Update `isBaselineEligibleViolation`.
- Include `baseline_policy` or `suppressible` in violation metadata if needed.

Acceptance tests:

- Existing architecture violation can be baselined during adoption.
- New architecture violation after baseline fails.
- Complexity max violation is not suppressed unless explicit policy enables it.

### P0: Contract evolution events omit before/after content required by the source design

Location:

- `docs/agent-contract-system-design.md`, section 6.3 type B
- `docs/design/agent-contract-implementation-design.md`, section 6.2

The source design requires contract evolution events to record before/after contract content. The implementation design only records `before_hash` and `after_hash`.

Hashes prove that something changed, but not what changed. For Stele, contract evolution is the highest-risk action because it can relax enforcement. Without before/after content or a normalized diff, later review cannot answer whether the contract was tightened, relaxed, or bypassed.

Required change:

- Add either:
  - `before_content` and `after_content`, for the exact contract declaration affected; or
  - `normalized_before`, `normalized_after`, and `diff`.
- Include `evolution_direction: "tighten" | "relax" | "neutral" | "unknown"`.
- Include `linked_research_event_id?: string`, even if v1 allows it to be absent.

Acceptance test:

- Modifying a contract declaration records a contract evolution event with before/after declaration text.
- Baseline update records before/after baseline hash plus reason.
- Add-only proposal records `after_content` and no `before_content`.

### P0: TypeScript dependency resolution is too weak for real architecture contracts

Location:

- `docs/design/agent-contract-implementation-design.md`, section 4.5

The design lists relative path resolution, `baseUrl`, and `paths`. That is not enough for real TypeScript projects. It misses important cases:

- `moduleResolution: node16`, `nodenext`, `bundler`
- extension resolution for `.ts`, `.tsx`, `.mts`, `.cts`
- `index.ts` directory resolution
- package `exports`
- workspace package imports
- multiple tsconfig files
- project references

Wrong resolution creates false positives and false negatives. For architecture contracts, that damages trust quickly.

Required change:

- Use TypeScript's `resolveModuleName` with compiler options loaded from the nearest applicable tsconfig.
- Add a `tsconfig` field to the DSL or config override:

```lisp
(architecture BACKEND_ARCHITECTURE
  (lang typescript)
  (tsconfig "tsconfig.json")
  ...)
```

- Define fallback behavior when no tsconfig exists.
- Record unresolved local-looking specifiers as warnings/notices, not silent ignores.

Acceptance tests:

- Relative imports resolve.
- `paths` aliases resolve.
- `index.ts` directory imports resolve.
- `.tsx` imports resolve.
- package import inside a workspace package resolves to modeled module if configured.
- external npm packages remain ignored.

### P1: Generated TypeScript architecture tests have an unresolved dependency packaging problem

Location:

- `docs/design/agent-contract-implementation-design.md`, section 13.1
- `packages/backend-typescript/package.json`

The design says generated Vitest runtime may require project-local `typescript`. But `@stele/backend-typescript` currently depends only on `@stele/core`; TypeScript is only a monorepo root devDependency.

That means published generated tests may fail in consuming projects unless the app already has `typescript`. Most TS apps will, but relying on that implicitly is not a robust contract-system design.

Required change:

- If generated runtime imports `typescript`, make `typescript` a direct dependency of the package that ships the runtime.
- Preferred: `@stele/architecture-core` depends on `typescript`, and both CLI/backend depend on it.
- Add packed-adoption test that installs Stele into a fresh TS fixture and runs generated architecture tests.

Acceptance test:

- `pnpm pack` / npm install into a temporary project.
- Run `stele generate`.
- Run Vitest generated architecture tests without relying on the monorepo root.

### P1: Report schema change for `notices` needs a migration/compatibility rule

Location:

- `docs/design/agent-contract-implementation-design.md`, sections 5.5 and 8.1

Adding optional `notices` is probably backward-compatible for tolerant JSON consumers, but the design leaves it as "if considered backward compatible." That is too vague for implementation.

Required change:

- Decide explicitly:
  - Keep `schema_version: "1"` and define optional `notices` as backward-compatible; or
  - bump to `schema_version: "2"`.
- If keeping version 1, add a compatibility section saying consumers must ignore unknown optional fields.
- Update `formatViolationReportHuman`, `formatViolationReportJson`, report summary, recursive check output, and tests.

Acceptance tests:

- JSON output includes `notices`.
- Existing no-notice reports remain byte-equivalent if no notices are produced.
- Human output prints notices without failing.
- Recursive check aggregates notices without affecting exit code.

### P1: L3 role parsing conflicts with phased implementation

Location:

- `docs/design/agent-contract-implementation-design.md`, sections 5.1 and 5.3

The design lists five roles and says first implementation should fully support `business-core-service`, while other roles may parse but fail with "not implemented." That creates awkward UX: the DSL accepts roles that cannot be checked.

Required change:

- Either:
  - Phase 2 supports only `business-core-service` in the parser; or
  - all listed roles must have working metrics in Phase 2.
- Recommended: parser accepts only `business-core-service` for the first phase. Keep other roles in the source design, not the implementation spec.

Acceptance test:

- `(role hub-coordinator)` fails with a clear parser error in Phase 2.
- The error message says only `business-core-service` is supported in this version.

### P1: Event system does not define retention, privacy, or gitignore policy

Location:

- `docs/design/agent-contract-implementation-design.md`, section 6.1

Events may contain file paths, cause summaries, contract content, and possibly business-sensitive rule text. The design says events are runtime artifacts and not protected by default, but does not say whether they should be committed, ignored, rotated, or redacted.

Required change:

- Add default `.gitignore` guidance for `.stele/events/`.
- Define max file size or rotation.
- Redact obvious secrets in event details using existing report redaction patterns if available.
- Document that event files are local observability artifacts unless the user explicitly opts into committing/exporting them.

Acceptance test:

- `stele init` adds `.stele/events/` to `.gitignore` or docs clearly instruct manual ignore.
- Event writer caps or rotates large JSONL files.

### P2: `--architecture-only` and `--complexity-only` semantics need exact stage definitions

Location:

- `docs/design/agent-contract-implementation-design.md`, sections 4.7 and 5.6

The design says `--architecture-only` still runs generated/protected integrity checks. It says `--complexity-only` should catch over-max. It does not define whether baseline, diff scoping, event recording, or generated drift checks run in each mode.

Required change:

Define a stage matrix:

| Mode | Generated drift | Protected drift | L1 invariants | L2 architecture | L3 complexity | Code-shape | Events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | yes | yes | generated tests | yes | yes | yes | yes |
| `--architecture-only` | yes/no decision | yes/no decision | no | yes | no | no | yes |
| `--complexity-only` | yes/no decision | yes/no decision | no | no | yes | no | yes |
| `--no-complexity` | yes | yes | yes | yes | no | yes | no metric event |

Acceptance test:

- Each mode has a fixture proving skipped stages really skip and included stages really run.

### P2: Complexity metric definitions need exact AST counting fixtures

Location:

- `docs/design/agent-contract-implementation-design.md`, section 5.4

The metric definitions are directionally good, but implementation will still differ unless the spec includes exact edge cases.

Required change:

Add fixture examples for:

- method overload signatures;
- abstract methods;
- arrow function class fields;
- private `#method`;
- decorators;
- nested local functions;
- logical expressions in return statements;
- switch fallthrough;
- optional chaining should not count as branch unless explicitly decided.

Acceptance test:

- One fixture per edge case asserts exact metric values.

## Required Design Revisions Before Implementation

Before assigning implementation work, revise the design document to:

1. Make `packages/architecture-core` mandatory.
2. Define baseline eligibility for L2 and L3.
3. Add before/after content to contract evolution events.
4. Replace custom TypeScript resolution with TypeScript compiler `resolveModuleName`.
5. Resolve TypeScript runtime dependency packaging.
6. Make `notices` schema/version policy explicit.
7. Limit Phase 2 parser support to `business-core-service` or implement all listed roles.
8. Add event retention/privacy/gitignore policy.
9. Add a check-mode stage matrix.
10. Add metric edge-case fixtures.

## Suggested Implementation Order After Revision

1. Revise design doc according to P0/P1 findings.
2. Implement shared architecture-core first.
3. Wire CLI architecture check.
4. Wire generated TypeScript architecture tests using the same core.
5. Add baseline policy for architecture.
6. Implement core-node parser and business-core metrics.
7. Add report notices with explicit compatibility tests.
8. Add event recording.
9. Add research-mode output changes.

## Final Review Judgment

The design direction is strong and aligned with the product philosophy, but it is not ready for implementation as-is.

The main reason: several "implementation choices" are actually enforcement-strength decisions. In Stele, enforcement-strength decisions cannot be left optional or duplicated across runtimes. The document should be revised before development starts.

