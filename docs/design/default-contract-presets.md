# Stele Default Contract Presets Design

Generated: 2026-05-18
Status: design proposal
Scope: default maintainability, architecture, security, testing, release, contract, and agent-maintenance rules

## 1. Purpose

Stele should ship a small but opinionated set of default contract presets.

The goal is not to replace ESLint, Ruff, Sonar, Biome, dependency-cruiser, or other code quality tools. Those tools are good at detecting local code smells. Stele should turn the rules that matter to a project into executable, explainable, baseline-aware contracts that agents can understand and maintain over time.

Default presets should protect five things:

1. Maintainability: prevent files, functions, classes, and modules from growing beyond reviewable size.
2. Architecture: prevent package boundaries and dependency direction from drifting.
3. Security: protect shell execution, project-root trust, contract files, baseline, manifest, and generated files.
4. Testing quality: prevent hollow tests that do not prove real behavior.
5. Agent maintenance: let agents add new contract knowledge while tightly controlling modification or deletion of existing rules.

## 2. Non-Goals

The default presets should not:

- Reimplement every lint rule from ESLint, Ruff, Sonar, or Biome.
- Block legacy adoption by failing all historical debt on day one.
- Treat generated, vendored, or fixture code the same as source code.
- Encourage agents to bypass hooks by making hook output purely adversarial.
- Auto-modify or auto-delete existing contract rules.

## 3. Preset Modes

Stele should expose three initialization modes:

```text
stele init --preset legacy-friendly
stele init --preset balanced
stele init --preset strict
```

### 3.1 `legacy-friendly`

Use this for existing projects with unknown debt.

- Maintainability budgets start as warnings.
- Architecture violations may be baselined.
- Security, release, protected-file, manifest, and baseline integrity remain errors.
- `stele baseline-init` is recommended during adoption.

### 3.2 `balanced`

Use this as the default recommendation.

- Architecture, security, release, and protected control-plane rules are errors.
- Maintainability budgets are warnings until severe thresholds are exceeded.
- Testing effectiveness rules are warnings by default, errors for new contract primitives and CLI commands.
- Agent maintenance rules are enabled.

### 3.3 `strict`

Use this for new projects, core packages, or projects that want strong governance.

- Maintainability budgets use tighter thresholds.
- Testing effectiveness rules are errors.
- Long-lived warnings require triage.
- New public API, CLI command, and contract primitive changes require high-quality tests.

## 4. Rule Model

Every default rule should be represented by a stable rule model:

```ts
type DefaultRule = {
  id: string;
  category:
    | "maintainability"
    | "architecture"
    | "security"
    | "testing"
    | "release"
    | "contract"
    | "agent";
  severity: "info" | "warning" | "error";
  scope: string[];
  exclude: string[];
  source: "stele-native" | "eslint" | "ruff" | "sonar" | "custom-checker";
  threshold?: Record<string, number>;
  rationale: string;
  fix: string;
};
```

The `source` field is important. If an existing tool is better at a check, Stele should invoke or ingest that tool instead of reimplementing it. Stele owns project contract semantics, baseline behavior, failure explanations, and agent guidance.

## 5. Global Exclusions

Default presets should exclude:

```text
node_modules/**
dist/**
build/**
coverage/**
.turbo/**
.next/**
.pytest_cache/**
.ruff_cache/**
*.lock
pnpm-lock.yaml
package-lock.json
yarn.lock
**/*.min.js
**/*.map
**/__snapshots__/**
tests/contract/**
contract/.manifest.json
contract/.baseline.json
```

Generated files should also be excluded using `stele.config.json.generatedDir`.

Fixtures should not be excluded globally. Instead, fixture and test paths should use wider thresholds because tests often need intentionally awkward examples.

## 6. Preset File Layout

Generated default contracts should be organized as separate preset files:

```text
contract/
  main.stele
  presets/
    maintainability.stele
    architecture.stele
    security.stele
    testing.stele
    release.stele
    agent-maintenance.stele
  proposals/
    agent-additions.stele
  checker_impls/
    quality_budget.py
    workspace_architecture.py
    release_integrity.py
    security_static.py
    test_effectiveness.py
```

`contract/main.stele` should import them:

```lisp
(import "./presets/maintainability.stele")
(import "./presets/architecture.stele")
(import "./presets/security.stele")
(import "./presets/testing.stele")
(import "./presets/release.stele")
(import "./presets/agent-maintenance.stele")
(import "./proposals/agent-additions.stele")
```

This keeps Stele-shipped defaults separate from agent-proposed additions.

## 7. Maintainability Preset

Maintainability rules are mostly code-quality budget rules. Existing tools can provide much of the raw signal, while Stele provides contract semantics, severity, baseline, and agent guidance.

### 7.1 Rules

```text
QUALITY_FILE_SIZE_BUDGET
QUALITY_FUNCTION_SIZE_BUDGET
QUALITY_NESTING_DEPTH_BUDGET
QUALITY_CYCLOMATIC_COMPLEXITY_BUDGET
QUALITY_PARAMETER_COUNT_BUDGET
QUALITY_EXPORT_COUNT_BUDGET
QUALITY_CLASS_SIZE_BUDGET
```

### 7.2 Default Thresholds

| Rule | Balanced | Strict | Notes |
| --- | ---: | ---: | --- |
| Single source file size | warning 400 lines, error 700 lines | warning 300 lines, error 500 lines | Tests may use 1.5x threshold |
| Single function size | warning 80 lines, error 150 lines | warning 60 lines, error 100 lines | Prefer extraction when behavior is separable |
| Nesting depth | warning 4, error 6 | warning 3, error 5 | Count control-flow nesting |
| Cyclomatic complexity | warning 10, error 15 | warning 8, error 12 | Delegate to ESLint/Sonar when available |
| Function parameter count | warning 5, error 7 | warning 4, error 6 | Config/options objects are preferred |
| Exports per file | warning 15, error 30 | warning 10, error 20 | Barrels may be explicitly exempt |
| Methods per class | warning 20, error 35 | warning 15, error 25 | Large classes should split responsibilities |

### 7.3 Example Contract

```lisp
(checker quality-function-size-budget
  (description "Check that functions stay within reviewable size budgets."))

(invariant QUALITY_FUNCTION_SIZE_BUDGET
  (severity warning)
  (category "maintainability")
  (description "Functions should stay small enough to review and safely modify.")
  (rationale "Large functions increase agent edit risk and human review cost.")
  (explain "If this fails, split orchestration from parsing, validation, or formatting logic.")
  (uses-checker quality-function-size-budget))
```

## 8. Architecture Preset

Architecture rules are a strong fit for Stele because they represent project-specific boundaries rather than generic lint.

### 8.1 Rules

```text
ARCH_CORE_HAS_NO_OUTWARD_DEPENDENCY
ARCH_BACKENDS_DO_NOT_CROSS_IMPORT
ARCH_CLI_DOES_NOT_IMPORT_PLUGIN_INTERNALS
ARCH_MCP_DOES_NOT_IMPORT_BACKEND_RUNTIME
ARCH_PLUGIN_DOES_NOT_IMPORT_CLI_INTERNALS
ARCH_SRC_DOES_NOT_IMPORT_TESTS
ARCH_NO_WORKSPACE_CYCLES
ARCH_PUBLIC_PACKAGES_DO_NOT_DEPEND_ON_UNPUBLISHED_PACKAGES
```

### 8.2 Stele Repository Defaults

For Stele itself:

- `packages/core` must not import `packages/cli`, `packages/mcp-server`, `packages/agent-hooks`, `packages/claude-code-plugin`, or `packages/github-action`.
- `packages/backend-*` must not import each other.
- `packages/cli` may depend on `@stele/core` and backend packages, but should not depend on plugin script internals.
- `packages/mcp-server` should not directly import backend runtime implementations.
- `packages/claude-code-plugin` should use public bin/API boundaries rather than CLI internals.
- `src/**` must not import `tests/**`.
- Public packages must not depend on unpublished workspace packages.
- Workspace package dependency graph must not contain cycles.

### 8.3 Example Contract

```lisp
(checker arch-core-has-no-outward-dependency
  (description "Check that core does not depend on integration packages."))

(invariant ARCH_CORE_HAS_NO_OUTWARD_DEPENDENCY
  (severity error)
  (category "architecture")
  (description "Core must not depend on CLI, MCP, hooks, plugins, or GitHub Action packages.")
  (rationale "Core is the stable contract engine and must remain reusable.")
  (explain "Move integration-specific code out of core; expose a core API instead.")
  (uses-checker arch-core-has-no-outward-dependency))
```

## 9. Security Preset

Security rules should protect Stele's own trust boundary and the user's control plane.

### 9.1 Rules

```text
SEC_NO_SHELL_TRUE_WITH_UNTRUSTED_INPUT
SEC_NO_COMMAND_STRING_CONCAT
SEC_PROJECT_DIR_MUST_STAY_WITHIN_WORKSPACE
SEC_PROTECTED_CONTROL_PLANE_FILES
SEC_BASELINE_REQUIRES_REASONED_UPDATE
SEC_GENERATED_FILES_NOT_MANUALLY_EDITED
SEC_NO_HARDCODED_SECRETS
SEC_HOOKS_FAIL_CLOSED
SEC_LOCAL_BINARY_TRUST_BOUNDARY
```

### 9.2 Protected Control Plane

Default protected paths:

```text
contract/**/*.stele
contract/checker_impls/**/*
contract/.manifest.json
contract/.baseline.json
stele.config.json
.claude/settings.json
.cursor/rules/**
packages/*/scripts/*hook*.js
tests/contract/**/*
```

### 9.3 Security Policy

- `shell: true` is forbidden when arguments contain hook payload, file paths, git diff paths, user prompts, or MCP input.
- Hook payload must not be concatenated into shell command strings.
- MCP `projectDir` must stay inside a configured workspace root allowlist.
- Baseline updates require `stele baseline-update --reason`.
- Generated files must not be edited manually.
- Hook errors must fail closed, but hook output must explain the safe path forward.

### 9.4 Example Contract

```lisp
(checker sec-no-shell-true-with-untrusted-input
  (description "Check shell execution sites for untrusted arguments."))

(invariant SEC_NO_SHELL_TRUE_WITH_UNTRUSTED_INPUT
  (severity error)
  (category "security")
  (description "Hook, plugin, and MCP code must not execute shell commands with untrusted input.")
  (rationale "Untrusted paths and hook payloads can become shell injection vectors.")
  (explain "Use shell:false or execFile-style APIs; validate paths against the project root.")
  (uses-checker sec-no-shell-true-with-untrusted-input))
```

## 10. Testing Preset

Testing rules should measure whether tests prove behavior, not just whether tests exist.

### 10.1 Rules

```text
TEST_PUBLIC_API_REQUIRES_TEST
TEST_CLI_COMMAND_REQUIRES_E2E
TEST_CONTRACT_PRIMITIVE_REQUIRES_GOLDEN
TEST_BUGFIX_REQUIRES_REGRESSION
TEST_MOCK_HEAVY_MODULE_REQUIRES_INTEGRATION
TEST_NO_LOW_VALUE_ASSERTION_ONLY
TEST_CONFORMANCE_HAS_NEGATIVE_FIXTURE
TEST_REPORT_FIELDS_ARE_ASSERTED
```

### 10.2 Requirements

New CLI commands should test:

- exit code
- stdout
- stderr
- JSON output when applicable
- packed/adoption flow when the command affects installation or project bootstrap

New contract primitives should test:

- parser behavior
- structural validation
- positive fixture
- negative fixture
- JSON report golden
- human report golden
- backend execution if the primitive generates tests

Test suites should not rely only on low-value assertions such as:

```text
toBeDefined()
not.toThrow()
toContain("some string")
```

These assertions may be used, but they must not be the only proof for behavior-critical code.

### 10.3 Example Contract

```lisp
(checker test-contract-primitive-requires-golden
  (description "Check that new contract primitives include parser, validator, fixture, and report golden coverage."))

(invariant TEST_CONTRACT_PRIMITIVE_REQUIRES_GOLDEN
  (severity error)
  (category "testing")
  (description "New contract primitives must include parser, validator, positive, negative, and report golden tests.")
  (rationale "Contract primitives define project governance; regressions must be visible in behavior and reports.")
  (explain "Add paired pass/fail fixtures and assert JSON and human report output.")
  (uses-checker test-contract-primitive-requires-golden))
```

## 11. Release Preset

Release rules should prove that published artifacts work outside the monorepo.

### 11.1 Rules

```text
RELEASE_TYPECHECK_AND_LINT_MUST_PASS
RELEASE_PACKED_ADOPTION_INSTALLS_PACKED_CLI
RELEASE_PUBLISH_LIST_COVERS_RUNTIME_DEPS
RELEASE_NO_WORKSPACE_PROTOCOL_IN_TARBALL
RELEASE_PACKAGE_HAS_FILES_WHITELIST
RELEASE_PACKAGE_HAS_NPM_METADATA
RELEASE_ACTION_ENTRY_EXISTS
RELEASE_LOCKFILE_SYNCED
RELEASE_DOC_PACKAGE_LIST_SYNCED
RELEASE_DRY_RUN_REQUIRED_BEFORE_PUBLISH
```

### 11.2 Requirements

- `typecheck` and `lint` must pass before release.
- Packed adoption must install the current `@stele/cli` tarball.
- Tarballs must not contain `workspace:*`.
- Public packages must include `license`, `repository`, `bugs`, `homepage`, and a `files` whitelist.
- Public packages should include README, or be explicitly marked internal/private.
- Publish list must include every public runtime dependency.
- GitHub Action entrypoint must exist in the consumable artifact.
- Release documentation must match the actual package list.
- Tag publish must run release dry-run before real publish.

### 11.3 Example Contract

```lisp
(checker release-packed-adoption-installs-packed-cli
  (description "Check that packed adoption installs and runs the CLI tarball built from this repository."))

(invariant RELEASE_PACKED_ADOPTION_INSTALLS_PACKED_CLI
  (severity error)
  (category "release")
  (description "Packed adoption tests must install and execute the CLI tarball built from this repository.")
  (rationale "A local workspace passing does not prove npm users can install the package.")
  (explain "Update packed adoption to install @stele/cli tarball and assert the resolved binary path.")
  (uses-checker release-packed-adoption-installs-packed-cli))
```

## 12. Contract Quality Preset

Stele contracts should themselves be governed.

### 12.1 Rules

```text
CONTRACT_RULE_HAS_DESCRIPTION
CONTRACT_RULE_HAS_EXPLAIN
CONTRACT_RULE_HAS_RATIONALE
CONTRACT_RULE_HAS_CATEGORY
CONTRACT_RULE_HAS_OWNER_OR_AREA
CONTRACT_RULE_ID_IS_STABLE
CONTRACT_NO_DUPLICATE_RULE_ID
CONTRACT_CHECKER_HAS_IMPL
CONTRACT_CHECKER_IMPL_HAS_TEST
CONTRACT_SCENARIO_HAS_SANDBOX
CONTRACT_NO_DIRECT_MODIFY_EXISTING_RULE_BY_AGENT
CONTRACT_AGENT_ADDITIONS_ARE_ADD_ONLY
```

### 12.2 Recommended Invariant Fields

Each durable invariant should include:

```lisp
(severity error)
(category "security")
(description "Short factual statement.")
(rationale "Why this matters.")
(explain "How an agent should reason about this rule.")
(applies-to "packages/claude-code-plugin/scripts/**/*.js")
```

### 12.3 Contract Mutation Policy

- Adding new proposed invariants is allowed through `stele propose invariant`.
- Modifying or deleting existing invariants requires human review.
- Rule IDs should be stable and should not be renamed silently.
- Checker-backed rules must have checker implementations.
- Checker implementations must have tests.
- Scenarios should declare sandbox behavior explicitly.

## 13. Agent Maintenance Preset

Agent rules should guide behavior rather than merely block it.

### 13.1 Rules

```text
AGENT_MUST_READ_CONTRACT_CONTEXT
AGENT_SHOULD_NOT_EDIT_PROTECTED_FILES_DIRECTLY
AGENT_SHOULD_PROPOSE_NEW_RULES_ADD_ONLY
AGENT_MUST_REQUEST_REVIEW_FOR_RULE_MODIFICATION
AGENT_MAINTENANCE_SUMMARY_REQUIRED_PERIODICALLY
AGENT_STALE_PROPOSALS_REQUIRE_TRIAGE
AGENT_WARNING_RULES_REQUIRE_DECISION_AFTER_TTL
```

### 13.2 Behavior

SessionStart should inject:

- active invariant summary
- protected paths
- add-only proposal workflow
- warning that contract modification or deletion requires user review

PreEdit should:

- run cheap protected-path and obvious-risk checks
- explain why the path is sensitive
- suggest `stele propose invariant` for additions
- tell the agent to ask the user before modifying or deleting existing rules

Stop should:

- run `stele check`
- run contract tests where configured
- detect protected-file drift
- ask the agent to reason whether the change is truly necessary
- avoid output that nudges the agent toward bypass attempts

Maintenance should:

- summarize recent code changes
- suggest new contract additions
- write only to proposals
- never modify or delete existing rules automatically

## 14. Baseline Strategy

Default rules must be baseline-aware.

Recommended behavior:

- Security, release, manifest, baseline, and protected control-plane rules should not be silently baselined away.
- Maintainability rules may baseline existing debt.
- Architecture rules may baseline legacy projects in `legacy-friendly`, but should fail new violations.
- Testing rules may baseline old gaps but should fail new feature gaps.
- Contract integrity rules should not be suppressed by default.

For budget rules, baseline should support ratcheting. Instead of only recording a violation fingerprint, Stele should record current maximums:

```json
{
  "QUALITY_FUNCTION_SIZE_BUDGET": {
    "packages/cli/src/commands/check.ts": {
      "maxFunctionLines": 182,
      "mode": "ratchet"
    }
  }
}
```

Future checks should allow the file to stay the same or improve, but fail if it gets worse.

## 15. Execution Layers

### 15.1 PreEdit

PreEdit should run only cheap checks:

- protected paths
- obvious shell execution risk
- obvious forbidden imports for touched files
- obvious generated file edits

It should not run full repository scans.

### 15.2 Stop

Stop should run:

- `stele check`
- manifest/protected/generated verification
- contract tests
- selected changed-file quality checks

### 15.3 CI and Release

CI and release should run:

- full contract check
- typecheck
- lint
- test
- conformance
- packed adoption
- release dry-run

### 15.4 Maintenance

Maintenance should run periodically or on demand:

- inspect recent diffs
- summarize new architecture or behavior knowledge
- propose add-only contract rules
- leave modifications and deletions for human review

## 16. Initial Rollout

### 16.1 P0 Default Rules

Ship these first:

```text
ARCH_CORE_HAS_NO_OUTWARD_DEPENDENCY
ARCH_NO_WORKSPACE_CYCLES
ARCH_PUBLIC_PACKAGES_DO_NOT_DEPEND_ON_UNPUBLISHED_PACKAGES
SEC_NO_SHELL_TRUE_WITH_UNTRUSTED_INPUT
SEC_PROTECTED_CONTROL_PLANE_FILES
SEC_BASELINE_REQUIRES_REASONED_UPDATE
RELEASE_PACKED_ADOPTION_INSTALLS_PACKED_CLI
RELEASE_PUBLISH_LIST_COVERS_RUNTIME_DEPS
RELEASE_ACTION_ENTRY_EXISTS
CONTRACT_RULE_HAS_DESCRIPTION
CONTRACT_AGENT_ADDITIONS_ARE_ADD_ONLY
```

### 16.2 P1 Default Rules

Add after the P0 rules are stable:

```text
QUALITY_FILE_SIZE_BUDGET
QUALITY_FUNCTION_SIZE_BUDGET
QUALITY_COMPLEXITY_BUDGET
TEST_CONTRACT_PRIMITIVE_REQUIRES_GOLDEN
TEST_CLI_COMMAND_REQUIRES_E2E
TEST_NO_LOW_VALUE_ASSERTION_ONLY
AGENT_MAINTENANCE_SUMMARY_REQUIRED_PERIODICALLY
```

### 16.3 P2 Default Rules

Add after baseline and ratcheting are reliable:

```text
QUALITY_DUPLICATION_BUDGET
QUALITY_EXPORT_COUNT_BUDGET
TEST_MUTATION_OR_PROPERTY_FOR_PARSER
CONTRACT_WARNING_TTL
CONTRACT_STALE_PROPOSAL_TRIAGE
```

## 17. Implementation Notes

The current CDL v0.1 can express these rules through `checker` plus `invariant`.

For the first implementation, default presets can use checker-backed rules:

```lisp
(checker release-publish-list-covers-runtime-deps
  (description "Check that public runtime dependencies are included in the release package set."))

(invariant RELEASE_PUBLISH_LIST_COVERS_RUNTIME_DEPS
  (severity error)
  (category "release")
  (description "Every public runtime workspace dependency must be included in the publish set.")
  (rationale "Published packages must install outside the monorepo.")
  (explain "Add missing public runtime packages to the publish list or remove the runtime dependency.")
  (uses-checker release-publish-list-covers-runtime-deps))
```

When code-shape primitives are stable, some checker-backed rules can migrate to declarative forms such as `boundary`, `file-policy`, `function-shape`, and `type-policy`.

The migration should preserve rule IDs so baselines, reports, and agent guidance remain stable.

## 18. Design Principle

Stele default rules should not try to check every possible code smell.

The purpose is to make important project governance executable:

- boundaries
- release trust
- testing proof
- contract integrity
- agent behavior
- maintainability budgets

Existing code-quality tools can produce raw findings. Stele should decide which findings matter to the project, explain why they matter, baseline legacy debt, and teach agents how to keep the contract alive.
