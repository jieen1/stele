# Agent Contract Implementation Design

> Status: implementation design
>
> Source document: `docs/agent-contract-system-design.md`
>
> Goal: turn the approved product direction into concrete Stele implementation work. This document intentionally keeps only items with enough detail to build and test. Pure ideas, future speculation, and visual/UI directions are out of scope.

## 1. Scope

This design adds four concrete capabilities:

1. L2 architecture contracts: module/layer/dependency invariants enforced from a real dependency graph.
2. L3 complexity contracts: core-node metrics with `ideal/current/max` boundaries, enforced at completion/check time.
3. Event recording: append-only records for contract hits, contract evolution, and complexity metric snapshots.
4. Research-mode guidance: a consistent agent-facing flow when a contract is hit.

This design does not implement:

- WebUI.
- Fake acceptance-report detection.
- Semantic duplicate-code detection.
- Wrong-abstraction detection.
- Multi-language architecture adapters beyond TypeScript.
- Go/Java/Rust L2/L3 support.
- Project-wide health scores for decision making.

The first implementation target is TypeScript because architecture dependencies and public API shape are more accurately recoverable from AST/module resolution than in dynamic languages.

Phase 1 must introduce one shared enforcement core for architecture rules. CLI checks and generated TypeScript tests must call the same evaluator; duplicated implementations are not acceptable because they can drift and weaken the contract.

## 2. Current System Anchors

The implementation should reuse the existing Stele architecture rather than create a parallel product.

Current anchors:

- `packages/core/src/validator/structure-types.ts`: declares top-level DSL kinds and normalized contract types.
- `packages/core/src/validator/structure-parse.ts`: dispatches top-level forms into typed declarations.
- `packages/cli/src/commands/check.ts`: central check pipeline for generated files, protected files, code-shape checks, baseline filtering, and diff scoping.
- `packages/cli/src/commands/rules.ts`: machine-readable rule index used by humans and agents.
- `packages/cli/src/commands/agentContext.ts`: agent-facing focused context.
- `packages/backend-typescript/src/backend.ts`: TypeScript/Vitest generated test surface.
- `packages/claude-code-plugin/scripts/stop-validate.js`: completion-time enforcement and agent guidance.
- `packages/claude-code-plugin/scripts/observation-hook.js`: existing source-edit observation feed.

Important distinction:

- Existing `boundary/class-shape/function-shape/type-policy/file-policy` code-shape rules are not L2 architecture contracts.
- Existing `observe` and `score` commands are not L3 complexity contracts or the event system.

## 3. Design Principles

1. Positive architecture definitions are preferred over negative bans.
   A module should declare what it may depend on. New dependency edges are illegal until explicitly modeled.

2. L2 keeps the existing contract-to-test philosophy.
   The DSL should produce architecture assertion tests, and `stele check` should also evaluate the same rules directly for fast, precise reporting.

3. L3 does not generate unit tests.
   Complexity is a stateful metric boundary, not a business invariant. It should run inside `stele check` and hooks as a completion-time gate.

4. Only core nodes get L3 limits.
   Project-wide complexity linting creates noise. Stele should protect important nodes where architectural decay is expensive.

5. Warnings must not block completion.
   `current > ideal` is an advisory. `current > max` is a blocking contract violation.

6. Event data must be append-only and evidence-oriented.
   Record facts that cannot be reconstructed later. Do not store subjective agent judgments as truth.

7. Agent guidance must force research before escalation.
   A contract failure should not immediately ask the user. The agent must first investigate source-only fixes and explain evidence.

## 4. L2 Architecture Contracts

### 4.1 User-Facing DSL

Add a new top-level declaration:

```lisp
(architecture BACKEND_ARCHITECTURE
  (lang typescript)
  (tsconfig "tsconfig.json")
  (description "Backend dependency direction must stay explicit and acyclic.")

  (module api
    (paths "src/api/**/*.ts" "src/api/**/*.tsx")
    (public-entry "src/api/index.ts"))

  (module application
    (paths "src/application/**/*.ts"))

  (module domain
    (paths "src/domain/**/*.ts"))

  (module infrastructure
    (paths "src/infrastructure/**/*.ts"))

  (module shared
    (paths "src/shared/**/*.ts"))

  (layer presentation (modules api))
  (layer application-layer (modules application))
  (layer domain-layer (modules domain))
  (layer infrastructure-layer (modules infrastructure))
  (layer shared-layer (modules shared))

  (allow-dependency api application shared)
  (allow-dependency application domain shared)
  (allow-dependency domain shared)
  (allow-dependency infrastructure application domain shared)
  (allow-dependency shared)

  (deny-cycles)

  (fix "Move the dependency behind an allowed module boundary, or ask the user to approve an architecture contract change."))
```

Semantics:

- `architecture` id is globally unique.
- `(lang typescript)` is required for v1.
- `(tsconfig "...")` is optional. If omitted, Stele discovers the nearest `tsconfig.json` from the project root. If present, it must be a project-relative path without `..`.
- Each `(module ...)` declares ownership of one or more file globs.
- A file must belong to at most one module.
- Files outside all modules are ignored by the architecture rule.
- `(allow-dependency A B C)` means module `A` may depend on modules `B` and `C`.
- If a module imports a modeled module not listed in its allow set, Stele reports a violation.
- Self-dependency is always allowed.
- `(allow-dependency shared)` means `shared` may depend only on itself.
- `(deny-cycles)` rejects cycles among modeled modules.
- New modules or dependency directions are illegal until added to the contract by a human-reviewed contract change.

Not included in the first build:

- Interface implementation count.
- Layer syntax independent of modules.
- Dynamic runtime call graph.
- Type-only dependency policy.
- Per-edge severity overrides.

Those are valuable later, but the first version should prove dependency direction protection.

### 4.2 Core Types

Modify `packages/core/src/validator/structure-types.ts`:

```ts
export type ArchitectureLang = "typescript";

export type ArchitectureModuleDeclaration = {
  id: string;
  paths: string[];
  publicEntries: string[];
  span: SourceSpan;
};

export type ArchitectureLayerDeclaration = {
  id: string;
  modules: string[];
  span: SourceSpan;
};

export type ArchitectureAllowDependencyDeclaration = {
  from: string;
  to: string[];
  span: SourceSpan;
};

export type ArchitectureDeclaration = {
  kind: "architecture";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: ArchitectureLang;
  tsconfig?: string;
  description?: string;
  modules: ArchitectureModuleDeclaration[];
  layers: ArchitectureLayerDeclaration[];
  allowDependencies: ArchitectureAllowDependencyDeclaration[];
  denyCycles: boolean;
  fix?: string;
};
```

Add `architecture` to `TOP_LEVEL_DECLARATIONS`.

Add `architectures: ArchitectureDeclaration[]` to `ContractFile` and `Contract`.

### 4.3 Parser

Create `packages/core/src/validator/structure-architecture.ts`.

Parser validation:

- `architecture` starts with identifier id.
- Exactly one `(lang typescript)`.
- Optional single `(tsconfig "...")`.
- At least one `(module ...)`.
- Each module has at least one `(paths ...)`.
- Module ids are unique inside the declaration.
- Layer ids are unique inside the declaration.
- Every layer module reference resolves to a local module.
- Every `allow-dependency` source and target resolves to a local module.
- `(deny-cycles)` takes no arguments.
- `(description "...")` optional, single string.
- `(fix "...")` optional, single string.
- Unknown fields fail with actionable messages.
- `tsconfig` path must be project-relative, must not contain `..`, and must end in `.json`.

Modify `structure-parse.ts` to dispatch `architecture`.

Modify `uniqueness.ts` to enforce global architecture ids.

Modify `references.ts` to validate module/layer references if that is cleaner than parser-local checks. Parser-local checks are preferred for references inside a single architecture declaration because all referenced objects are local.

### 4.4 Dependency Graph Model

Create `packages/cli/src/architecture/types.ts`:

```ts
export type ArchitectureModuleId = string;

export type DependencyImportKind =
  | "static-import"
  | "dynamic-import"
  | "export-from"
  | "require-call";

export type DependencyEdge = {
  fromModule: ArchitectureModuleId;
  toModule: ArchitectureModuleId;
  fromFile: string;
  toFile?: string;
  specifier: string;
  importKind: DependencyImportKind;
  line: number;
  column: number;
};

export type ArchitectureGraph = {
  architectureId: string;
  modules: Record<ArchitectureModuleId, string[]>;
  edges: DependencyEdge[];
  unownedFiles: string[];
  ambiguousFiles: Array<{ file: string; modules: string[] }>;
  unresolvedSpecifiers: Array<{
    fromFile: string;
    specifier: string;
    line: number;
    column: number;
  }>;
};
```

Rules:

- All paths are project-relative POSIX paths.
- Edges are deduplicated by `fromFile + toModule + specifier + line + column`.
- Unresolved specifiers are not violations in v1 unless they resolve to a modeled module path but cannot be mapped.
- Type-only imports count as dependencies in v1. A later policy can distinguish type-only edges.

### 4.5 TypeScript Extractor

Create `packages/cli/src/architecture/typescript-extractor.ts`.

Use the `typescript` compiler API. Do not use regex for import parsing.

Inputs:

- `projectDir`
- one `ArchitectureDeclaration`
- optional `tsconfig` path, discovered from `tsconfig.json` at project root for v1

Responsibilities:

1. Expand module path globs.
2. Build file-to-module map.
3. Detect ambiguous ownership.
4. Parse each owned `.ts`/`.tsx` source file.
5. Extract:
   - `import ... from "x"`
   - `export ... from "x"`
   - `import("x")`
   - `require("x")`
6. Resolve specifiers through TypeScript's compiler resolver:
   - load compiler options from the architecture declaration's `(tsconfig "...")` or discovered `tsconfig.json`;
   - call `typescript.resolveModuleName`;
   - respect `baseUrl`, `paths`, `moduleResolution`, extension resolution, directory `index.ts`/`index.tsx`, and package exports as TypeScript reports them;
   - support `node`, `node16`, `nodenext`, and `bundler` module resolution modes through compiler options;
   - package imports are ignored only when TypeScript resolves them outside modeled project files.
7. Map resolved target file to target module.
8. Emit graph.

Do not run TypeScript type checking. This is a structural import graph, not a compiler validation pass.

Unresolved imports:

- External package specifiers that TypeScript cannot resolve are ignored.
- Relative imports and alias imports that look project-local but cannot resolve produce a non-blocking notice.
- A specifier that resolves to a modeled module must never be ignored.

Path expansion should use the existing project dependencies if available. If no project glob utility exists, add a focused helper:

- `packages/cli/src/utils/glob.ts`

It must:

- accept project-relative patterns only;
- reject absolute paths and `..`;
- return sorted POSIX paths;
- ignore `node_modules`, `.git`, `dist`, `build`, `coverage`, `.stele`.

### 4.6 Architecture Evaluator

Create `packages/cli/src/architecture/evaluate.ts`.

Evaluator stages:

1. Build graph.
2. Report ambiguous file ownership as configuration violation.
3. Report dependency direction violations.
4. If `denyCycles` is true, detect cycles among module-level edges.

Violation shape:

```ts
createViolation({
  rule_id: architecture.id,
  rule_kind: "architecture_dependency",
  severity: "error",
  source: { tool: "stele", command, kind: "architecture" },
  location: { path: edge.fromFile, line: edge.line, column: edge.column },
  cause: {
    summary: `Module "${edge.fromModule}" may not depend on "${edge.toModule}".`,
    detail: `Import "${edge.specifier}" creates ${edge.fromModule} -> ${edge.toModule}, but allowed targets are: ${allowed.join(", ") || "<none>"}.`,
  },
  scope_paths: [edge.fromFile],
  fix: {
    summary: architecture.fix ?? "Move the dependency behind an allowed module boundary or update the architecture contract after user review.",
  },
});
```

Cycle violation:

- `rule_kind: "architecture_cycle"`
- `location.path`: first edge file in the cycle
- `cause.detail`: `api -> application -> infrastructure -> api`
- `scope_paths`: all files participating in the cycle edges

### 4.7 `stele check` Integration

Modify `packages/cli/src/commands/check.ts`:

- Add `buildArchitectureStageReport`.
- Run it after protected-stage and before code-shape-stage.
- Apply baseline filtering and `--diff-from` filtering.
- For `--diff-from`, evaluate full graph but mark violations out-of-scope when none of their `scope_paths` are in diff scope. Full graph is required to detect cycles accurately.

Add option:

```bash
stele check --architecture-only
```

This should run generated/protected integrity checks plus architecture checks, but skip scenario/code-shape/complexity checks. It is useful for fast agent repair loops.

### 4.8 Baseline Policy

Architecture violations are baseline-eligible for legacy adoption, but only by fingerprint and scope path.

Rules:

- `architecture_dependency` and `architecture_cycle` violations may be suppressed by `baseline-init` and `baseline-update`.
- Baseline suppression is allowed for existing architecture debt when adopting Stele into a legacy project.
- New architecture violations after baseline must fail.
- Generated/protected drift violations remain non-suppressible.
- Baseline files remain protected and locked like existing baselines.

Implementation:

- Extend baseline eligibility beyond current `source.kind === "rule" && rule_kind === "rule_violation"`.
- Add a helper such as `getBaselinePolicy(violation)` returning:
  - `"eligible"` for L1 invariant rule violations and L2 architecture dependency/cycle violations;
  - `"never"` for generated/protected/manifest drift;
  - `"explicit-only"` for complexity max violations.
- v1 should treat complexity max violations as `"never"` unless a future explicit option is implemented.

Tests:

- Existing architecture violation can be captured by `baseline-init`.
- The same architecture violation is suppressed by later `stele check`.
- A new architecture edge not in baseline fails.
- Complexity max violation is not suppressed by a normal baseline.

### 4.9 Generated TypeScript Tests

L2 must also produce generated tests for TypeScript projects.

Modify `packages/backend-typescript/src/backend.ts`:

- If `contract.architectures.length > 0`, emit:
  - `tests/contract/test_architecture.ts`
  - `tests/contract/_stele_architecture_runtime.ts`

Generated test behavior:

- The test imports a generated runtime helper.
- The generated runtime helper delegates to `@stele/cli/architecture-runtime`.
- `@stele/cli/architecture-runtime` scans project files at test execution time through `@stele/architecture-core`.
- The shared architecture core uses the TypeScript compiler API to parse import/export declarations.
- The test asserts the same dependency-direction and cycle rules as `stele check`.

Generated file example:

```ts
import { describe, expect, it } from "vitest";
import { evaluateArchitectureContract } from "./_stele_architecture_runtime";

describe("Stele architecture contracts", () => {
  it("BACKEND_ARCHITECTURE", () => {
    const result = evaluateArchitectureContract({
      projectRoot: process.cwd(),
      architecture: {
        id: "BACKEND_ARCHITECTURE",
        modules: [
          { id: "api", paths: ["src/api/**/*.ts", "src/api/**/*.tsx"] },
          { id: "application", paths: ["src/application/**/*.ts"] },
          { id: "domain", paths: ["src/domain/**/*.ts"] },
          { id: "infrastructure", paths: ["src/infrastructure/**/*.ts"] },
          { id: "shared", paths: ["src/shared/**/*.ts"] },
        ],
        allowDependencies: {
          api: ["application", "shared"],
          application: ["domain", "shared"],
          domain: ["shared"],
          infrastructure: ["application", "domain", "shared"],
          shared: [],
        },
        denyCycles: true,
      },
    });

    expect(result.violations).toEqual([]);
  });
});
```

The generated runtime and CLI must use one shared implementation.

Create `packages/architecture-core` in Phase 1.

Responsibilities:

- parse TypeScript imports from source text;
- resolve module specifiers through TypeScript compiler APIs;
- build architecture graphs;
- evaluate dependency direction and cycles;
- return serializable violation facts independent of CLI formatting.

Consumers:

- `@stele/cli` converts shared evaluator facts into Stele `Violation` objects.
- `@stele/cli` exposes `./architecture-runtime` as the generated-test runtime API, backed by `@stele/architecture-core`.
- `@stele/backend-typescript` renders generated tests that import the runtime through `@stele/cli/architecture-runtime`.

Duplicating evaluator logic inside CLI and generated tests is explicitly disallowed.

### 4.10 Agent Context and Rule Inventory

Modify `packages/cli/src/commands/rules.ts`:

- Include `architectures` in JSON summary.
- Include module count, dependency rule count, deny-cycle flag, source file/line.

Modify `packages/cli/src/commands/agentContext.ts`:

- Include relevant architecture rules when `--focus` path belongs to a modeled module.
- Tell the agent:
  - source fixes are preferred;
  - dependency direction changes require user review;
  - new architecture modules/dependency edges are contract changes, not casual fixes.

Modify `packages/cli/src/commands/explain.ts` and `why.ts`:

- Explain architecture rules and architecture violations.

### 4.11 L2 Tests

Add tests:

- Parser:
  - accepts valid architecture contract;
  - rejects duplicate module id;
  - rejects unknown allow-dependency module;
  - rejects non-TypeScript lang;
  - rejects module with no paths.

- Extractor:
  - static import creates edge;
  - re-export creates edge;
  - dynamic import creates edge;
  - require call creates edge;
  - TS path alias resolves to modeled module;
  - `index.ts` directory import resolves;
  - `.tsx` import resolves;
  - `moduleResolution: node16`, `nodenext`, and `bundler` fixtures resolve through TypeScript compiler options;
  - workspace package import resolves to modeled module when TypeScript resolves it into the project;
  - external package import ignored.

- Evaluator:
  - allowed dependency passes;
  - disallowed dependency fails with file/line;
  - cycle fails when `(deny-cycles)` is present;
  - cycle does not fail when absent.

- CLI:
  - `stele check` fails on architecture violation;
  - `stele check --architecture-only` skips code-shape but catches architecture;
  - `--diff-from` evaluates full graph but marks out-of-scope violations.

- Backend:
  - TypeScript backend emits `test_architecture.ts`;
  - generated Vitest catches the same forbidden dependency as CLI.

## 5. L3 Complexity Contracts

### 5.1 User-Facing DSL

Add a new top-level declaration:

```lisp
(core-node ORDER_SERVICE
  (lang typescript)
  (role business-core-service)
  (target "src/domain/order/OrderService.ts::OrderService")
  (description "Coordinates order lifecycle rules. It should not become a workflow god class.")

  (metric sloc (ideal 220) (max 360))
  (metric public-method-count (ideal 12) (max 20))
  (metric max-cyclomatic (ideal 8) (max 14))

  (rationale "This class changes often and owns core order lifecycle decisions. Splitting should happen before it exceeds reviewable size."))
```

Supported v1 role:

- `business-core-service`

Supported v1 metrics:

- `sloc`
- `public-method-count`
- `max-cyclomatic`

Role-to-metric validation:

| Role | Allowed v1 metrics |
| --- | --- |
| `business-core-service` | `sloc`, `public-method-count`, `max-cyclomatic` |

Future roles from the source design, such as `hub-coordinator`, `infrastructure-tool`, `business-rules-core`, and `module`, stay out of the first implementation. The parser should reject them with a clear error until their metrics are implemented end to end.

### 5.2 Core Types

Modify `packages/core/src/validator/structure-types.ts`:

```ts
export type CoreNodeLang = "typescript";

export type CoreNodeRole =
  | "business-core-service";

export type CoreNodeMetricName =
  | "sloc"
  | "public-method-count"
  | "max-cyclomatic";

export type CoreNodeMetricBoundary = {
  name: CoreNodeMetricName;
  ideal: number;
  max: number;
  span: SourceSpan;
};

export type CoreNodeDeclaration = {
  kind: "core-node";
  filePath: string;
  node: ListNode;
  span: SourceSpan;
  id: string;
  lang: CoreNodeLang;
  role: CoreNodeRole;
  target: string;
  description?: string;
  rationale?: string;
  metrics: CoreNodeMetricBoundary[];
};
```

Add `core-node` to `TOP_LEVEL_DECLARATIONS`.

Add `coreNodes: CoreNodeDeclaration[]` to `ContractFile` and `Contract`.

### 5.3 Parser

Create `packages/core/src/validator/structure-core-node.ts`.

Validation:

- `lang`, `role`, and `target` are required.
- At least one metric required.
- At most three metrics per core node.
- `ideal` and `max` required for every metric.
- `ideal <= max`.
- Metric values must be non-negative integers.
- Metric names must be allowed for the selected role.
- Duplicate metrics are rejected.
- `target` format:
  - class target: `path/to/file.ts::ClassName`
- v1 accepts only class targets.
- Unsupported roles fail at parse time. Do not accept a role that cannot be checked.

### 5.4 Metric Collector

Create `packages/cli/src/complexity/types.ts`:

```ts
export type CoreNodeMetricValue = {
  name: CoreNodeMetricName;
  current: number;
  ideal: number;
  max: number;
  state: "healthy" | "above_ideal" | "over_max";
};

export type CoreNodeMeasurement = {
  nodeId: string;
  role: CoreNodeRole;
  target: string;
  measuredAt: string;
  sourceFiles: string[];
  metrics: CoreNodeMetricValue[];
};
```

Create `packages/cli/src/complexity/typescript-metrics.ts`.

Metric definitions:

- `sloc`:
  - for symbol target, count source lines inside the AST node span;
  - remove blank lines and comment-only lines using TypeScript scanner;
  - count stable logical source lines, not physical file length.

- `public-method-count`:
  - class methods without `private`, `protected`, or `#`;
  - constructor does not count;
  - getter/setter counts as one public API per property name.

- `max-cyclomatic`:
  - evaluate every method/function under the target;
  - base complexity = 1;
  - increment for `if`, `for`, `for..of`, `for..in`, `while`, `do`, `case`, `catch`, conditional expression, `&&`, `||`, `??`;
  - report maximum method/function complexity.

Candidate suggestion may include extra diagnostic signals such as in-degree, out-degree, and recent git change frequency when the data is available, but those are not v1 core-node metrics and cannot be used in `(metric ...)` declarations yet.

### 5.5 Complexity Evaluator

Create `packages/cli/src/complexity/evaluate.ts`.

Evaluation:

- `current <= ideal`: healthy, no report item.
- `ideal < current <= max`: advisory, does not fail `stele check`.
- `current > max`: blocking violation.

The current violation model treats any active violation as failing. To support non-blocking advisories cleanly, add `notices` to `ViolationReport` rather than putting advisories in `violations`.

Compatibility decision:

- Keep `schema_version: "1"`.
- `notices` and `summary.notice_count` are optional backward-compatible fields.
- Existing no-notice reports must remain byte-equivalent in content.
- JSON consumers are expected to ignore unknown optional fields.

Modify `packages/core/src/report/types.ts`:

```ts
export type ViolationReportSummary = {
  message?: string;
  invariant_count?: number;
  generated_file_count?: number;
  protected_file_count?: number;
  violation_count: number;
  notice_count?: number;
  active_violation_count?: number;
  suppressed_violation_count?: number;
  out_of_scope_violation_count?: number;
};

export type ContractNotice = {
  notice_id: string;
  severity: "warning" | "info";
  source: ViolationSource;
  location: ViolationLocation;
  summary: string;
  detail?: string;
  scope_paths: string[];
  fix?: ViolationFix;
};

export type ViolationReport = {
  schema_version: "1";
  tool: string;
  command: string;
  ok: boolean;
  summary: ViolationReportSummary;
  violations: Violation[];
  notices?: ContractNotice[];
};
```

Rules:

- `notices` never affect `ok`.
- Human output prints notices after active violations, or after OK summary if no violations.
- JSON output includes notices.
- Baseline suppresses only violations, not notices.
- Recursive check aggregates `notice_count` but does not include notices in exit-code decisions.

Blocking L3 violation shape:

```ts
createViolation({
  rule_id: coreNode.id,
  rule_kind: "complexity_boundary",
  severity: "error",
  source: { tool: "stele", command, kind: "complexity" },
  location: { path: sourceFile, line: targetLine, column: targetColumn },
  cause: {
    summary: `Core node ORDER_SERVICE exceeded max for sloc: current 417 > max 360.`,
    detail: `Role business-core-service allows sloc up to 360. Ideal is 220. This node needs source refactoring, not a contract edit, unless the user approves a new architecture decision.`,
  },
  scope_paths: sourceFiles,
  fix: {
    summary: "Split responsibilities or extract a collaborator without changing the core-node boundary. If the boundary is wrong, ask the user for contract review.",
  },
});
```

Advisory notice shape:

```json
{
  "notice_id": "ORDER_SERVICE:sloc:above_ideal",
  "severity": "warning",
  "summary": "Core node ORDER_SERVICE is above ideal for sloc: current 281 > ideal 220, max 360.",
  "detail": "Touching this node should include a small refactor if it fits the requested change."
}
```

### 5.6 `stele check` Integration

Modify `packages/cli/src/commands/check.ts`:

- Add `buildComplexityStageReport`.
- Run after architecture stage.
- Include `notices` in merged report.
- Blocking complexity violations use existing exit behavior.

Add options:

```bash
stele check --complexity-only
stele check --no-complexity
```

`--no-complexity` is useful during early adoption but should be visible in output:

```text
OK 12 invariants checked; complexity checks skipped by --no-complexity.
```

Baseline policy:

- `complexity_boundary` violations are not suppressible by normal `baseline-init`.
- The purpose of L3 is to stop core-node decay once boundaries are agreed. Letting a generic baseline hide `max` overflow would weaken that contract.
- If a legacy project starts above max, the correct onboarding path is to set an honest initial `max` through human review, not to baseline the violation silently.
- A future explicit command may support `stele baseline-complexity --node <id> --reason <reason>`, but that command is not part of this design.

### 5.7 Initialization Commands

Add command group:

```bash
stele complexity suggest --lang typescript --output .stele/complexity/candidates.json
stele complexity measure --json
```

`suggest` behavior:

- Scan TypeScript project files.
- Rank candidates by:
  - SLOC;
  - public method count;
  - max cyclomatic complexity;
  - import out-degree;
  - import in-degree;
  - recent git change frequency if git is available.
- Output data only, not contract edits.

Candidate output:

```json
{
  "schema_version": "1",
  "generated_at": "2026-05-18T00:00:00.000Z",
  "language": "typescript",
  "candidates": [
    {
      "target": "src/domain/order/OrderService.ts::OrderService",
      "suggested_role": "business-core-service",
      "signals": {
        "sloc": 312,
        "public_method_count": 18,
        "max_cyclomatic": 11,
        "in_degree": 7,
        "out_degree": 5,
        "recent_commits": 14
      },
      "reason": "Large, frequently changed class with high dependency centrality."
    }
  ]
}
```

`measure` behavior:

- Reads existing `core-node` declarations.
- Emits current metric values.
- Does not modify contracts.

No command should automatically write `core-node` declarations. Core-node boundaries are human design decisions.

### 5.8 L3 Tests

Add tests:

- Parser:
  - accepts valid core-node;
  - rejects missing role;
  - rejects unsupported roles such as `hub-coordinator` in v1;
  - rejects duplicate metric;
  - rejects `ideal > max`;
  - rejects too many metrics.

- Metrics:
  - SLOC ignores comments and blank lines;
  - public method count ignores private/protected/# methods;
  - getter/setter pair counts once;
  - max cyclomatic counts branch constructs consistently.
  - method overload signatures do not count as executable public methods;
  - abstract method declarations count as public API but not cyclomatic complexity;
  - arrow function class fields count as public API when public;
  - decorators do not change method visibility;
  - nested local functions are measured for `max-cyclomatic` when they sit inside the target class method body;
  - `switch` cases count deterministically, including fallthrough cases;
  - optional chaining does not increment cyclomatic complexity in v1.

- Evaluator:
  - current below ideal reports no notice;
  - current above ideal reports notice and exit 0;
  - current above max reports violation and non-zero check.

- CLI:
  - `stele check --complexity-only` catches over-max;
  - `stele check --no-complexity` skips complexity and says so;
  - JSON output contains `notices`.

## 6. Event Recording

### 6.1 Storage

Create append-only JSONL files:

- `.stele/events/contract-events.jsonl`
- `.stele/events/complexity-metrics.jsonl`

These files are runtime observation artifacts and should not be part of the protected contract by default.

Default repository policy:

- `stele init` should add `.stele/events/` to `.gitignore` when it creates or updates Stele local artifacts.
- Existing projects that already manage `.gitignore` manually should receive a CLI message recommending the same ignore entry.
- Event files are local observability data unless the user explicitly exports or commits them.

Path safety:

- Create parent directories with `mkdir`.
- Refuse to write if `.stele/events` or target file is a symlink.
- Append one complete JSON object per line.
- If writing fails, do not fail `stele check`; emit stderr warning unless strict mode is later introduced.

Retention and privacy:

- Rotate a JSONL file when it exceeds 10 MB.
- Keep at most five rotated files per stream: `.1` through `.5`.
- Redact obvious secrets in free-text fields and content snapshots using case-insensitive key/name patterns: `password`, `token`, `secret`, `api_key`, `apikey`, `authorization`.
- Redaction replaces values with `"<redacted>"`; it must not change event structure.
- Contract snapshots are useful for audit, but can contain business-sensitive rules. The default ignore policy is therefore mandatory.

### 6.2 Event Types

Create `packages/cli/src/events/types.ts`.

Base fields:

```ts
export type SteleEventBase = {
  schema_version: "1";
  event_id: string;
  timestamp: string;
  project_dir: string;
  git_commit?: string;
  git_dirty?: boolean;
  session_id?: string;
};
```

Contract violation event:

```ts
export type ContractViolationEvent = SteleEventBase & {
  kind: "contract_violation";
  contract_id: string;
  contract_type: "invariant" | "code-shape" | "architecture" | "complexity" | "protected" | "generated";
  trigger_action: string;
  violation_fingerprint: string;
  rule_kind: string;
  files: Array<{ path: string; line?: number; column?: number }>;
  core_node_id?: string;
  metrics?: Record<string, { current: number; ideal?: number; max?: number }>;
  cause_summary: string;
};
```

Contract evolution event:

```ts
export type ContractEvolutionEvent = SteleEventBase & {
  kind: "contract_evolution";
  contract_id: string;
  evolution_type: "add" | "modify" | "delete" | "baseline-update" | "lock-update";
  before_content?: string;
  after_content?: string;
  before_hash?: string;
  after_hash?: string;
  diff?: string;
  evolution_direction: "tighten" | "relax" | "neutral" | "unknown";
  linked_research_event_id?: string;
  reason?: string;
  user_approved?: boolean;
  source_command: string;
};
```

Complexity metric event:

```ts
export type ComplexityMetricEvent = SteleEventBase & {
  kind: "complexity_metric";
  core_node_id: string;
  target: string;
  role: string;
  metrics: Record<string, { current: number; ideal: number; max: number; state: string }>;
  source_files: string[];
};
```

### 6.3 Event Writers

Create:

- `packages/cli/src/events/write-event.ts`
- `packages/cli/src/events/git.ts`
- `packages/cli/src/events/session.ts`

Writers:

- `recordContractViolations(projectDir, report, triggerAction)`
- `recordContractEvolution(projectDir, event)`
- `recordComplexityMeasurements(projectDir, measurements)`

Trigger points:

- `stele check`: write one `contract_violation` event per active violation; write complexity metric snapshots when L3 ran.
- `stele propose invariant --apply`: write `contract_evolution` with `evolution_type: "add"`.
- `stele baseline-init` and `baseline-update`: write `baseline-update`.
- `stele lock`: write `lock-update`.
- `stele lock` must also detect contract declaration additions/modifications/deletions since the previous manifest or baseline human state and write one `contract_evolution` event per changed declaration when possible.

Evolution content rules:

- Add: `after_content` contains the added declaration; `before_content` is omitted.
- Modify: both `before_content` and `after_content` contain the normalized declaration text.
- Delete: `before_content` contains the removed declaration; `after_content` is omitted.
- Baseline/lock updates may omit declaration content but must include before/after hash and reason.
- `evolution_direction` is `"unknown"` unless Stele can deterministically classify the change as tightening or relaxing.
- If Stele cannot map a file diff to a single declaration, record a file-level `contract_evolution` event with `contract_id: "<file>"`, before/after file content redacted, and `evolution_direction: "unknown"`.

Do not record `notices` as contract violations. Complexity notices are captured in metric snapshots.

### 6.4 Event Tests

Add tests:

- appends valid JSONL for check violation;
- records propose add event;
- records baseline update event;
- records before/after content for contract modification in a focused fixture;
- redacts secret-like fields in event content;
- rotates event files above the configured size;
- writes complexity metric snapshot;
- refuses symlinked event path;
- check still returns original failure even if event writing fails.

## 7. Research-Mode Guidance

### 7.1 Principle

When a contract is hit, Stele should guide the agent into investigation before escalation.

The agent must answer:

1. Which rule failed?
2. What exact file/line caused it?
3. What source-only fixes were considered?
4. Why is changing contract/baseline/manifest not the first move?
5. If a contract change is truly needed, what should the user review?

### 7.2 CLI Output

Modify `packages/cli/src/commands/why.ts` to include a research template for active violations:

```markdown
## Required Agent Research

Before asking the user to change contract files:

1. Inspect the reported source file and the rule source.
2. Try a source-code or fixture repair path.
3. Re-run the narrowest relevant check.
4. If the violation still represents an intentional behavior or architecture change, ask the user for review.

Evidence to provide:

- Rule:
- Violating file/line:
- Source-only repair attempted:
- Check command run:
- Why contract change is necessary:
```

Modify `packages/claude-code-plugin/scripts/stop-validate.js`:

- Keep the existing guidance.
- Add the same structured research template.
- Do not say “just update baseline” as a normal fix.
- Make “modify/delete existing contract” explicitly user-reviewed.
- Keep `stele propose invariant --apply` as the add-only path for new knowledge.

### 7.3 Agent Context

Modify `agent-context` to include:

- architecture rules relevant to focused files;
- complexity core-node boundaries relevant to focused files;
- research-mode instructions.

For a file inside a core node, `stele agent-context --focus src/domain/order/OrderService.ts` should say:

```text
Core node: ORDER_SERVICE
Role: business-core-service
Current boundaries:
- sloc ideal 220 max 360
- public-method-count ideal 12 max 20
- max-cyclomatic ideal 8 max 14

If your change increases this node, prefer local simplification or extraction before completion.
Changing these boundaries requires user review.
```

### 7.4 Research Guidance Tests

Add tests:

- `stele why <fingerprint>` includes research template.
- Stop hook failure output includes research template.
- `agent-context --focus` includes architecture rule context.
- `agent-context --focus` includes core-node context.

## 8. Reporting Changes

### 8.1 Violation Report Schema

Keep `schema_version: "1"`. `notices` are an optional extension and do not change violation semantics. Consumers that only read `violations` and `ok` remain compatible.

Add:

- `notices?: ContractNotice[]`
- `summary.notice_count?: number`

Do not make warnings fail `ok`.

No-notice reports should preserve the existing shape except for optional `notice_count` being omitted. Do not emit `notices: []` unless a caller explicitly asks for fully expanded JSON in a future option.

### 8.2 Human Output

Example OK with notices:

```text
OK 12 invariants checked; 4 generated files and 8 protected files verified.

[warning] ORDER_SERVICE:sloc:above_ideal
  source: complexity/check
  location: src/domain/order/OrderService.ts:12:1
  summary: Core node ORDER_SERVICE is above ideal for sloc: current 281 > ideal 220, max 360.
  fix: If touching this node, simplify or extract behavior where it fits the requested change.
```

Example blocking architecture violation:

```text
[error] BACKEND_ARCHITECTURE
  source: architecture/check
  location: src/domain/order/OrderService.ts:7:1
  summary: Module "domain" may not depend on "infrastructure".
  detail: Import "../infrastructure/db" creates domain -> infrastructure, but allowed targets are: shared.
  fix: Move the dependency behind an allowed module boundary, or ask the user to approve an architecture contract change.
  fingerprint: 4f7bc1d20932
```

## 9. Command Summary

New commands/options:

```bash
stele check --architecture-only
stele check --complexity-only
stele check --no-complexity

stele complexity suggest --lang typescript --output .stele/complexity/candidates.json
stele complexity measure --json
```

Existing commands to extend:

```bash
stele check
stele rules --json
stele explain <id>
stele why <id-or-fingerprint>
stele agent-context --focus <path>
stele propose invariant --apply
stele baseline-init
stele baseline-update
stele lock
```

### 9.1 Check Mode Stage Matrix

`stele check` modes must have exact stage semantics.

| Mode | Generated drift | Protected drift | L1 generated test freshness | L2 architecture | L3 complexity | Code-shape | Baseline filtering | Event recording |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| default | yes | yes | yes | yes | yes | yes | yes | violations + complexity metrics |
| `--architecture-only` | yes | yes | yes | yes | no | no | yes | architecture violations |
| `--complexity-only` | yes | yes | yes | no | yes | no | yes for non-complexity stages; complexity not suppressible | complexity violations + metrics |
| `--no-complexity` | yes | yes | yes | yes | no | yes | yes | violations only; no complexity metrics |

Notes:

- Generated/protected drift checks always run because they guard contract tampering and generated-test freshness.
- `--architecture-only` and `--complexity-only` skip expensive or unrelated semantic checks but do not skip integrity checks.
- Event recording follows the stages that actually ran.
- `--diff-from` applies to architecture and code-shape violations by `scope_paths`. Complexity checks run only for core nodes whose source files intersect the diff scope; if no core node intersects, emit an OK summary saying complexity was out of scope.

## 10. Implementation Phases

### Phase 1: L2 Architecture Contract MVP

Deliverable:

- Shared `@stele/architecture-core` evaluator.
- TypeScript architecture DSL.
- CLI architecture graph extractor.
- `stele check` architecture stage.
- TypeScript generated architecture test.
- Agent context/rules/explain/why support.

Acceptance:

- A TS fixture with `domain -> infrastructure` import fails.
- Moving dependency behind allowed module passes.
- New dependency direction fails until contract is explicitly updated.
- Generated Vitest test catches the same violation as CLI check.

### Phase 2: L3 Business Core Complexity

Deliverable:

- `core-node` DSL.
- TypeScript metrics for `business-core-service`.
- Blocking `max` violations.
- Non-blocking `ideal` notices.
- `complexity suggest` and `complexity measure`.

Acceptance:

- A class above `ideal` but below `max` exits 0 and prints notice.
- A class above `max` exits non-zero.
- Private methods do not inflate public method count.
- Comments/blank lines do not inflate SLOC.

### Phase 3: Event Recording

Deliverable:

- Append-only event store.
- Violation events from `stele check`.
- Evolution events from propose/baseline/lock.
- Complexity metric snapshots.

Acceptance:

- Every blocking architecture/complexity failure writes a valid event.
- Contract add via `propose invariant --apply` writes an evolution event.
- Event write failure does not hide the original contract failure.

### Phase 4: Research-Mode Guidance

Deliverable:

- `why` research template.
- Stop hook research template.
- Focused architecture/core-node context in `agent-context`.

Acceptance:

- Agent-facing output tells the agent to attempt source-only repair before asking the user.
- Contract modification/deletion path always requires explicit user review.
- New rule addition remains add-only through `stele propose invariant --apply`.

## 11. File-Level Implementation Map

Core parser/types:

- Modify `packages/core/src/validator/structure-types.ts`
- Modify `packages/core/src/validator/structure-parse.ts`
- Modify `packages/core/src/validator/structure.ts`
- Modify `packages/core/src/validator/uniqueness.ts`
- Create `packages/core/src/validator/structure-architecture.ts`
- Create `packages/core/src/validator/structure-core-node.ts`
- Modify `packages/core/src/report/types.ts`
- Modify `packages/core/src/report/format.ts`

Architecture implementation:

- Create `packages/architecture-core/package.json`
- Create `packages/architecture-core/src/index.ts`
- Create `packages/architecture-core/src/types.ts`
- Create `packages/architecture-core/src/typescript-resolver.ts`
- Create `packages/architecture-core/src/graph.ts`
- Create `packages/architecture-core/src/evaluate.ts`
- Create `packages/cli/src/architecture-runtime.ts`
- Modify `packages/cli/package.json` exports to include `./architecture-runtime`
- Create `packages/cli/src/architecture/types.ts`
- Create `packages/cli/src/architecture/typescript-extractor.ts`
- Create `packages/cli/src/architecture/module-map.ts`
- Create `packages/cli/src/architecture/evaluate.ts`
- Create `packages/cli/src/architecture/cycles.ts`
- Create `packages/cli/src/utils/glob.ts` if no reusable safe glob exists
- Modify `packages/cli/src/commands/check.ts`
- Modify `packages/cli/src/commands/rules.ts`
- Modify `packages/cli/src/commands/agentContext.ts`
- Modify `packages/cli/src/commands/explain.ts`
- Modify `packages/cli/src/commands/why.ts`

Generated TypeScript architecture tests:

- Modify `packages/backend-typescript/src/backend.ts`
- Create `packages/backend-typescript/src/architecture-renderer.ts`
- Create `packages/backend-typescript/src/architecture-runtime.ts`
- Add tests under `packages/backend-typescript/tests/`

Package dependencies:

- `@stele/architecture-core` depends directly on `typescript`.
- `@stele/cli` depends on `@stele/architecture-core`.
- `@stele/backend-typescript` does not need to depend on `@stele/architecture-core` unless it imports shared serialization types. Its generated tests should depend on `@stele/cli/architecture-runtime` at runtime.
- `@stele/cli` exports `./architecture-runtime`.
- The generated `_stele_architecture_runtime.ts` imports from `@stele/cli/architecture-runtime`, because consuming projects install `@stele/cli` directly.
- Generated tests must not import `@stele/architecture-core` directly; that would fail under strict package managers when `architecture-core` is only a transitive dependency.
- If `@stele/cli` is not installed in the consuming project, generated architecture tests must fail with a clear message telling the user to install `@stele/cli` as a dev dependency.

Complexity implementation:

- Create `packages/cli/src/complexity/types.ts`
- Create `packages/cli/src/complexity/typescript-metrics.ts`
- Create `packages/cli/src/complexity/evaluate.ts`
- Create `packages/cli/src/commands/complexity.ts`
- Modify `packages/cli/src/index.ts`
- Modify `packages/cli/src/commands/check.ts`
- Modify `packages/cli/src/commands/agentContext.ts`

Events:

- Create `packages/cli/src/events/types.ts`
- Create `packages/cli/src/events/write-event.ts`
- Create `packages/cli/src/events/git.ts`
- Create `packages/cli/src/events/session.ts`
- Modify `packages/cli/src/commands/check.ts`
- Modify `packages/cli/src/commands/propose.ts`
- Modify `packages/cli/src/commands/baseline.ts`
- Modify `packages/cli/src/commands/lock.ts`

Claude plugin guidance:

- Modify `packages/claude-code-plugin/scripts/stop-validate.js`
- Modify `packages/claude-code-plugin/skills/contract-aware-coding/SKILL.md`
- Modify `packages/claude-code-plugin/commands/context.md`
- Modify `packages/claude-code-plugin/commands/maintain.md`

Docs:

- Update `docs/spec/cdl.md`
- Update `docs/spec/cli-output.md`
- Update `docs/guides/claude-code-plugin.md`
- Add examples under `examples/` after Phase 1 and Phase 2 land.

## 12. Test Plan

Run these after each phase:

```bash
pnpm test
pnpm --filter @stele/core test
pnpm --filter @stele/cli test
pnpm --filter @stele/backend-typescript test
pnpm --filter @stele/claude-code-plugin test
```

Add focused e2e fixtures:

- `packages/cli/tests/fixtures/typescript-architecture-valid`
- `packages/cli/tests/fixtures/typescript-architecture-invalid-edge`
- `packages/cli/tests/fixtures/typescript-architecture-cycle`
- `packages/cli/tests/fixtures/typescript-core-node-ideal-warning`
- `packages/cli/tests/fixtures/typescript-core-node-max-fail`

Each fixture should be runnable without network.

Additional packed-adoption fixture:

- Create a temporary TypeScript app.
- Install packed Stele packages.
- Run `stele init --language typescript`.
- Add an architecture contract.
- Run `stele generate`.
- Run the generated Vitest architecture test.
- Assert it works without relying on monorepo root dependencies.

The tests must assert behavior, not just snapshots:

- exact exit code;
- exact violated rule id;
- exact file path and line number;
- fix text includes source-first/user-review guidance;
- JSON schema includes expected fields;
- generated tests fail for the same reason as CLI check.

## 13. Risks and Decisions

### 13.1 TypeScript Runtime Dependency

Architecture extraction needs TypeScript AST.

Decision:

- `@stele/architecture-core` depends directly on `typescript`.
- CLI architecture checks use `@stele/architecture-core`.
- Generated Vitest architecture tests import a local generated `_stele_architecture_runtime.ts`.
- That local runtime imports `@stele/cli/architecture-runtime`, which is a public subpath export backed by `@stele/architecture-core`.
- The generated runtime must not require the consuming project to declare `typescript` or `@stele/architecture-core` directly.
- If the bundled runtime cannot initialize TypeScript parsing, generated tests fail with a clear message:

```text
Stele architecture tests could not initialize the TypeScript architecture runtime. Re-run "stele generate" with the installed Stele package, or run "stele check --architecture-only" for details.
```

### 13.2 Generated Test and CLI Divergence

Risk:

- CLI evaluator and generated test runtime can drift.

Decision:

- `packages/architecture-core` is mandatory.
- CLI and generated tests must consume evaluator logic from this shared package/source.
- Duplicating the evaluator in CLI and generated tests is not allowed.

### 13.3 Non-Blocking Warnings

Risk:

- Existing report model treats all active violations as failing.

Decision:

- Add `notices` instead of using warning violations for L3 ideal drift.
- Only `current > max` becomes a violation.

### 13.4 Contract Changes Are Still Human Decisions

Risk:

- Agent may “fix” architecture or core-node violations by relaxing DSL boundaries.

Decision:

- Existing protected-file guidance remains.
- `agent-context`, `why`, and Stop hook must explicitly say architecture/core-node boundary changes require user review.
- Add-only `propose invariant` remains allowed only for new invariants, not relaxing architecture or complexity boundaries.

## 14. Definition of Done

The system is done for this design when:

1. A TypeScript project can declare modules and allowed dependency directions in Stele DSL.
2. `stele check` blocks a real forbidden dependency with file/line/cause/fix.
3. Generated TypeScript contract tests block the same forbidden dependency.
4. A TypeScript project can declare one `business-core-service` core node.
5. `stele check` reports `ideal` drift as a notice and `max` overflow as a blocking violation.
6. Contract hits and contract evolution write append-only event records.
7. Agent-facing output consistently tells agents to research and prefer source fixes before asking for contract changes.
8. All new behavior has parser, evaluator, CLI, generated-test, and hook tests.
