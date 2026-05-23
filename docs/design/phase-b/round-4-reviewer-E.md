# Reviewer E — Stele dogfood audit (2026-05-23)

Independent audit of how thoroughly the Stele framework uses **its own**
mechanisms to govern its development. Conducted by an isolated sub-agent.

## Scope summary

Counted forms in `contract/main.stele` + `contract/generated/ddd-typedriven.stele`:

| Form | Count |
|---|---|
| `(invariant …)` | 31 |
| `(checker …)` | 31 |
| `(architecture …)` | 18 |
| `(core-node …)` | 10 |
| `(branded-id …)` | 4 |
| `(smart-ctor …)` | 3 |
| `(trace-policy …)` | **0** |
| `(type-state …)` | **0** |
| `(effect-policy …)` | **0** |
| `(boundary …) / (class-shape …) / (function-shape …) / (file-policy …) / (type-policy …)` | **0** |

Phase B / code-shape mechanisms are fully implemented and documented but
**Stele itself uses none of them**. The repo gates a
`STRICT_MODE_DEFAULT_IN_CI` and a `FIX_HINT_REQUIRES_ANALYSIS_BRANCH`
*meta*-invariant about evaluators existing — but never actually applies
the evaluators to its own source.

## Severity legend

- P0: a CLAUDE.md / spec rule has zero mechanical enforcement
- P1: a mechanism exists but is unused / under-applied
- P2: doc claims out of sync with code

## Findings

### E-01 P0 — "Core engine is pure" has no mechanical enforcement

**Claim**: `CLAUDE.md` line 56, README line 53.
**Reality**: `packages/core/src/{loader,manifest,generator/file-walk.ts,baseline/io.ts}` all `import { ... } from "node:fs/promises"`. There is no `effect-policy` forbidding side-effects outside an explicit IO module.
**Fix**: Add `(effect-policy CORE_PURE)` forbidding `clock`, `random`, `env`, and `network` effects on `packages/core/src/{ast,errors,registry,validator,normalizer,generator,parser,lexer}/**`, and tighter `forbid` on `fs:write` outside `loader/`, `manifest/`, `baseline/io.ts`.

### E-02 P0 — "ESM only — `.js` extensions in relative imports" has no enforcement

**Claim**: `CLAUDE.md` line 42.
**Reality**: No code-shape, file-policy, or checker covers this. A future agent dropping `.js` suffix silently breaks ESM consumers.
**Fix**: A `(file-policy ESM_RELATIVE_IMPORTS_KEEP_JS)` on `packages/*/src/**/*.ts` whose pattern requires every relative `import … from "./…"` / `"../…"` to end in `.js`.

### E-03 P0 — "Path safety is the hot path" is not traced

**Claim**: `CLAUDE.md` lines 59-60.
**Reality**: `grep -rn "path-utils\|resolve.*projectRoot" packages/cli/src/commands/check.ts` returns zero hits; CLI commands import `node:fs` directly. The static call-graph evaluator exists but is not wired against this repo.
**Fix**: Author a `(trace-policy CLI_IO_VIA_PATH_UTILS …)` with `must-pass-through` on the path-safety helper and `target-scope` on `packages/cli/src/commands/**`.

### E-04 P0 — "Hooks fail closed" only checks one script

**Claim**: `CLAUDE.md` line 62.
**Reality**: `hooks_fail_closed` only inspects `pre-tool-protect.js` for a top-level try-pattern. The other hook scripts (`observation-hook.js`, `stop-validate.js`, `lifecycle-context.js`) are not checked.
**Fix**: Add `(function-shape HOOK_ENTRYPOINTS_FAIL_CLOSED)` on all 4 hook scripts requiring outer try/catch + `process.exit(non-zero)` on the catch path. Generalize the existing `hooks_fail_closed` checker to all 4.

### E-05 P0 — Propose flow is documented but untested in this repo

**Claim**: `docs/spec/cdl.md` line 1030.
**Reality**: `contract/design/proposals/` and `contract/design/approvals/` do not exist. The CLI command points at them, but no exemplar of the flow ever being exercised exists.
**Fix**: Seed `contract/design/proposals/2026-…-example.yaml` + `contract/design/approvals/…` from a real change. Add an invariant `PROPOSAL_FLOW_EXERCISED` requiring at least one approved proposal exist, OR mark the doc as "future" and stop claiming it's the path.

### E-06 P1 — `branded-id` / `smart-ctor` declared but no boundary enforces "no raw strings"

**Claim**: `contract/generated/ddd-typedriven.stele` lines 462-499 declares branded IDs.
**Reality**: There is no `function-shape` saying "public functions in `@stele/core` that accept a path argument must accept `ContractPath`, not `string`".
**Fix**: Add a `(function-shape CORE_PUBLIC_API_USES_BRANDED_IDS)` requiring exported functions in `packages/core/src/loader/**` and `packages/core/src/manifest/**` to declare parameter types `ContractPath` / `Sha256` where applicable.

### E-07 P1 — No `type-state` for the loaded contract lifecycle

**Claim**: `docs/spec/cdl.md` documents type-state as the mechanism for "unloaded → loaded → frozen" state machines.
**Reality**: The type-state-evaluator runs against this repo's source but has zero declarations to evaluate.
**Fix**: `(type-state CONTRACT_LIFECYCLE (target "Contract") (states unloaded loaded frozen) (transition load: unloaded → loaded) (transition validate: loaded → frozen) (forbid-after frozen mutation))`.

### E-08 P1 — `(architecture …)` covers layer direction but no `(boundary …)` covers cross-package imports

**Claim**: README lines 287-296 + CLAUDE.md describe strict dependency direction.
**Reality**: No `(boundary …)` rule preventing `packages/backend-*/src/**` from importing `packages/cli/**`, and no rule forbidding `packages/core` from depending on any other `@stele/*` package.
**Fix**: Add an explicit `(boundary CORE_HAS_NO_STELE_DEPS …)` forbidding any `from "@stele/(cli|backend-.*|agent-hooks|claude-code-plugin|mcp-server|github-action)"` import inside `packages/core/src/**`.

### E-09 P1 — Supply-chain files unprotected

**Claim**: README "Security: SHA-256 manifest locking … agent-edit interception."
**Reality**: `stele.config.json` `protected` does **not** cover `pnpm-lock.yaml`, `package.json`, any `packages/*/package.json`, any `tsup.config.ts`, or `.github/workflows/*.yml`. An agent could silently set `dts: false` in `tsup.config.ts` and the release would publish a typeless package.
**Fix**: Add these to the protected list, then `stele lock`.

### E-10 P1 — `scripts/publish-npm.mjs` self-checks `workspace:*` but no invariant locks the check

**Claim**: CLAUDE.md "release script verifies that packed manifests do not contain `workspace:*`".
**Reality**: Hard-coded in `scripts/publish-npm.mjs:169`. No invariant locking the script's *presence* of that check.
**Fix**: Add a `release-script-rejects-workspace-protocol` checker.

### E-11 P1 — `--lenient` checker doesn't cover env-var-driven CLI scripts

**Claim**: `STRICT_MODE_DEFAULT_IN_CI` — no `--lenient-*` may reach `stele check`.
**Reality**: `self_protection.py` scans workflows but not `package.json#scripts.*`. A maintainer could put `--lenient-effects` in a `package.json` script and the workflow would call it via `pnpm check`.
**Fix**: Extend `_scan_text_for_lenient` to scan `package.json`'s `scripts` block and every `.mjs` / `.sh` in `scripts/`.

### E-12 P2 — README claims "27 invariants"; actual count is 31

**Claim**: `README.md` line 272: "the project's `contract/main.stele` contains 27 invariants".
**Reality**: 31 `(invariant …)` forms in `contract/main.stele`.
**Fix**: Update README text.

### E-13 P2 — Inconsistent protection of transient JSON state files

**Reality**: `.stele/stop-state.json` is protected but `contract/.last-check-report.json` is not. The asymmetry is doc-noise.
**Fix**: Document which transient JSON files are *intentionally* unprotected.

### E-14 P2 — `structural_types_stable` checker asserts 9 types, but spec lists no canonical list

**Reality**: The grep `STRUCTURAL_TYPES` in source returns nothing — the type literals only exist in `packages/core/src/ast/types.ts` as a union.
**Fix**: Either add the canonical list to the CDL spec, or downgrade the invariant message to refer to the union directly.

### E-15 P2 — `lifecycle-context.js` registered for `UserPromptSubmit` (undocumented)

**Reality**: `hooks.json` registers `lifecycle-context.js` on SessionStart, UserPromptSubmit, and PreToolUse. UserPromptSubmit isn't mentioned in README. Also `lifecycle-context.js` is not covered by `hooks_fail_closed`.
**Fix**: Document UserPromptSubmit in `claude-code-plugin.md`, extend the fail-closed checker.

## Strong dogfood examples (keep doing)

- `STRICT_MODE_DEFAULT_IN_CI` is *good* dogfood: a contract about Stele's own CI config, enforced by parsing YAML the same way an adopter would.
- `FIX_HINT_REQUIRES_ANALYSIS_BRANCH` is excellent — forces evaluator fix-hints to teach the [A] code-issue / [B] contract-issue split.
- `ALL_EVALUATORS_COMPILE` + `ALL_BACKENDS_COMPILE` mechanically verify every advertised feature ships a buildable dist/.
- `protected_pattern_safe` introspects the *config* shipped with the framework.
- The `(architecture …)` declarations in `ddd-typedriven.stele` give every package an explicit layer model with `deny-cycles`.
- Self-protection negative tests demonstrate that each positive checker actually fails on the wrong shape — uncommon discipline.

## Summary table

| #   | severity | gap                                                                |
| --- | -------- | ------------------------------------------------------------------ |
| E-01 | P0       | "Core engine is pure" — no `effect-policy`                         |
| E-02 | P0       | "ESM `.js` extensions" — no `file-policy`                          |
| E-03 | P0       | "Path safety in CLI / hooks" — no `trace-policy`                   |
| E-04 | P0       | "Hooks fail closed" — only one script checked                      |
| E-05 | P0       | Propose flow has no `contract/design/proposals/` exemplar          |
| E-06 | P1       | Branded IDs declared but no `function-shape` requires their use    |
| E-07 | P1       | `Contract` lifecycle has no `type-state`                           |
| E-08 | P1       | No `boundary` forbidding cross-package imports into `@stele/core`  |
| E-09 | P1       | `pnpm-lock.yaml`, `package.json`, `tsup.config.ts`, `workflows/` unprotected |
| E-10 | P1       | `publish-npm.mjs` `workspace:*` check is itself unprotected        |
| E-11 | P1       | `--lenient` scan misses `package.json` scripts and `scripts/*.mjs` |
| E-12 | P2       | README says 27 invariants; real count is 31                        |
| E-13 | P2       | Inconsistent protection of transient JSON state files              |
| E-14 | P2       | "9 structural types" list not in the CDL spec                      |
| E-15 | P2       | `lifecycle-context.js` + `UserPromptSubmit` undocumented           |

**Headline**: Stele's Phase B mechanisms and code-shape rules are
zero-use against the project's own source despite full implementation,
full spec documentation, and full evaluator packages. Phase A invariants
(31 checker-backed) and DDD architecture (18 contexts, 10 core-nodes) are
strong; **Phase B dogfood is the largest gap**.
