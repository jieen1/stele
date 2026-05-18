# Agent Contract Implementation Design Review Round 2

Date: 2026-05-18

Reviewed document:

- `docs/design/agent-contract-implementation-design.md`

Review goal:

- Verify that the first review's blocking findings were incorporated into the design.
- Identify any remaining ambiguity that should block implementation.

## Closure Matrix

| Prior finding | Round 2 status | Evidence |
| --- | --- | --- |
| L2 had two possible enforcement implementations | Closed | The design now makes `packages/architecture-core` mandatory and forbids duplicated evaluator logic. CLI uses architecture-core, generated tests use `@stele/cli/architecture-runtime`, which is backed by architecture-core. |
| Architecture/complexity baseline policy undefined | Closed | The design now defines L2 architecture violations as baseline-eligible and L3 complexity max violations as non-suppressible by normal baseline. |
| Contract evolution events only stored hashes | Closed | The design now adds `before_content`, `after_content`, `diff`, `evolution_direction`, and declaration/file-level fallback behavior. |
| TypeScript module resolution too weak | Closed | The design now requires `typescript.resolveModuleName`, tsconfig support, and fixtures for alias, index, `.tsx`, node16/nodenext/bundler, and workspace package resolution. |
| Generated TypeScript tests had package dependency ambiguity | Closed | The design now routes generated tests through `@stele/cli/architecture-runtime`, avoiding direct imports of transitive `@stele/architecture-core`. It also requires a clear failure if `@stele/cli` is missing. |
| `notices` schema/version policy vague | Closed | The design now explicitly keeps `schema_version: "1"` and defines `notices` / `summary.notice_count` as optional backward-compatible fields. |
| L3 listed roles that were not implemented | Closed | The design now limits v1 parser support to `business-core-service`; other roles are future and must be rejected. |
| Event retention/privacy/gitignore missing | Closed | The design now requires `.stele/events/` gitignore guidance, 10 MB rotation, five retained rotations, and secret redaction. |
| Check-mode semantics undefined | Closed | The design now includes a check-mode stage matrix for default, `--architecture-only`, `--complexity-only`, and `--no-complexity`. |
| Metric edge-case fixtures missing | Closed | The design now lists overloads, abstract methods, arrow class fields, private methods, decorators, nested local functions, switch fallthrough, and optional chaining fixtures. |

## Round 2 Findings

### P1: Architecture runtime subpath must be treated as a public API

The revised design depends on `@stele/cli/architecture-runtime` from generated tests. That is the right direction because the consuming project directly installs `@stele/cli`, but this subpath must be considered stable.

Implementation requirement:

- Add `./architecture-runtime` to `packages/cli/package.json` exports.
- Add type declarations for the subpath.
- Add a packed-adoption test that imports the subpath from a generated Vitest test.
- Do not rename or remove the subpath without a migration.

This is already implied by the revised design, but implementation must treat it as a compatibility contract.

### P2: Contract evolution direction classification can start conservative

The design allows `evolution_direction: "unknown"` unless Stele can deterministically classify tighten/relax. That is acceptable for v1.

Implementation guidance:

- Do not attempt AI or heuristic classification in the first implementation.
- Classify only obvious mechanical cases, for example:
  - new deny dependency or lower max boundary -> `tighten`;
  - new allow dependency or higher max boundary -> `relax`;
  - otherwise `unknown`.

This is not a blocker.

### P2: Complexity suggestion signals are advisory only

The design keeps in-degree/out-degree/recent git frequency as candidate suggestion signals, not v1 core-node metrics. That distinction is now clear.

Implementation guidance:

- Do not let suggestion-only signals appear in `(metric ...)`.
- Tests should reject `(metric in-degree ...)` in v1.

This is not a blocker.

## Final Round 2 Judgment

The implementation design is now ready to become a detailed implementation plan.

Remaining items are implementation discipline issues, not design blockers:

1. Treat `@stele/cli/architecture-runtime` as a stable generated-test API.
2. Keep contract evolution direction conservative.
3. Keep L3 suggestion signals separate from enforceable metrics.

Recommended next step:

- Write an implementation plan that starts with `@stele/architecture-core`, then wires CLI architecture checks, then generated TypeScript architecture tests, then L3 complexity, events, and research-mode guidance.

