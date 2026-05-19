# DDD + Type-Driven Pattern System Implementation Design

> Status: detailed design
>
> Date: 2026-05-19
>
> Source: `docs/ddd-typedriven-feature-design.md`
>
> Goal: turn DDD and Type-Driven project design choices into maintainable, enforceable Stele contracts without pretending that Stele can automatically infer good architecture.

## 1. Positioning

This feature should not become a generic "DDD generator" or a pile of templates. Its real job is narrower and stronger:

1. Capture human-approved project design choices in a versioned model.
2. Compile the enforceable parts of that model into Stele contracts and tool checks.
3. Expose the model and generated rules to agents so they understand why a boundary exists.
4. Detect drift between implementation and the approved model.

The useful prior art is not "ask 22 questions and generate folders". The useful prior art is model-to-implementation validation:

- Context Mapper treats context maps as machine-readable DDD models, with bounded contexts and relationships as first-class model elements. Its docs explicitly model Context Maps as bounded contexts plus relationships and include semantic validation rules. See [Context Mapper Context Map](https://contextmapper.org/docs/context-map/).
- Context Mapper's ArchUnit integration validates implementation against a DDD model and deliberately validates code-to-model drift. A key design decision there is one-way validation: implemented objects must exist in the model, but model objects do not all have to be implemented yet. See [Validating the Implementation against the Model with ArchUnit](https://contextmapper.org/docs/architecture-validation-with-archunit/).
- ArchUnit proves that architecture constraints can be expressed as executable tests over a dependency graph, including layered architectures, slices, module dependencies, and cycles. See [ArchUnit User Guide](https://www.archunit.org/userguide/html/000_Index.html).
- TypeScript already supports discriminated-union narrowing and `never`-based exhaustiveness checks. See [TypeScript narrowing and exhaustiveness checking](https://www.typescriptlang.org/docs/handbook/2/narrowing.html).
- `typescript-eslint` already provides rules such as `switch-exhaustiveness-check` and `no-explicit-any`; Stele should ingest and contextualize these results rather than reimplement them. See [switch-exhaustiveness-check](https://typescript-eslint.io/rules/switch-exhaustiveness-check/) and [no-explicit-any](https://typescript-eslint.io/rules/no-explicit-any/).
- Zod already turns runtime input validation into typed parse results. See [Zod basics](https://zod.dev/basics).

The Stele-specific value is: these checks become contract-aware, baseline-aware, protected, explainable to agents, and governed by human-approved design choices.

## 2. Current Code Reality

The current repository already contains parts of the needed substrate:

| Area | Current implementation | Design implication |
| --- | --- | --- |
| DSL top-level forms | `packages/core/src/validator/structure-types.ts` already includes `architecture` and `core-node`. | Do not invent a parallel syntax for architecture and complexity. Generate existing declarations first. |
| Architecture parser | `packages/core/src/validator/structure-architecture.ts` parses `(architecture ...)` with `lang`, `tsconfig`, `module`, `layer`, `allow-dependency`, `deny-cycles`, `fix`. | DDD context/layer choices can compile to current DSL. Generator must use current syntax: repeated `(path "...")`, not `(paths ...)`. |
| Architecture evaluator | `packages/architecture-core` extracts TypeScript imports and evaluates dependency edges/cycles. | Reuse it as the main hard-enforcement engine for Q1/Q2/Q4/Q11/Q13/Q14. |
| Generated TS architecture tests | `packages/backend-typescript/src/architecture-renderer.ts` emits Vitest tests calling `@stele/cli/architecture-runtime` when the project is configured for the TypeScript backend. | Generated DDD architecture rules can fit the contract-to-test pipeline, but `design check` must verify backend config or rely on the CLI `stele check` architecture stage as the primary enforcement path. |
| CLI architecture stage | `packages/cli/src/architecture/stage.ts` evaluates architecture during `stele check`. | Use this for fast Stop-hook feedback as well as generated tests. |
| Core-node complexity | `packages/core/src/validator/structure-core-node.ts` and `packages/cli/src/complexity/evaluate.ts` support `sloc`, `public-method-count`, `max-cyclomatic`. | Q10 can compile to existing `core-node` declarations for known aggregate roots/services. |
| Agent context | `packages/cli/src/commands/agentContext.ts` already includes architectures and core nodes. | Extend this with design-profile provenance instead of making agents read raw YAML unaided. |
| Add-only maintenance | `packages/cli/src/commands/propose.ts` and `maintenance.ts` already provide add-only invariant proposals and session summaries. | Design-profile evolution should follow the same add/modify governance principle. |
| Protected files | `packages/cli/src/config/defaults.ts` protects `.stele`, checker impls, manifest, baseline, and generated tests. | Add design-profile and generation-manifest files to protected globs. |

Important gaps that must be fixed before this feature can be trusted:

1. `architecture-runtime.ts` drops `tsconfig`, `layers`, and `publicEntries`; the DSL accepts them but runtime evaluation does not use them.
2. `architecture-runtime.ts` returns only dependency violations and loses cycle violations from `evaluateArchitecture`.
3. `check --architecture-only` and `check --complexity-only` still run code-shape checks because code-shape is only skipped by `--lenient`.
4. `evaluateCoreNode` silently reports zero metrics when a target file/class is missing. That should be a contract configuration violation, not success.
5. `rules.ts` indexes architectures roughly and does not index `core-node` contracts as first-class rules.
6. Code-shape DSL is Python-only (`CodeShapeLang = "python"`). TypeScript shape checks cannot be generated into existing `boundary/class-shape/function-shape/type-policy/file-policy` yet.

These are not side issues. If this feature generates rules into a partially wired enforcement path, agents will learn the wrong lesson: "the model exists but does not really bite."

## 3. Product Model

The first shippable version has these protected control-plane artifacts:

```text
contract/
  design/
    profile.yaml
    generation-manifest.json
    approvals/
      *.json
  generated/
    ddd-typedriven.stele
```

`contract/design/profile.yaml` is the human-approved source of truth. It is not generated from code, and modifying it is a contract change.

`contract/generated/ddd-typedriven.stele` is generated from the profile. Agents should not edit it by hand. Regeneration is allowed only when the profile changed through the approved path.

`contract/design/generation-manifest.json` records profile hash, generator identity, generator content hash, template hash when templates exist, generated file hashes, and rule provenance. It lets `stele check` distinguish legitimate regeneration from manual edits.

Project-local templates are not part of v1. If added later, they must live under a protected path and be hashed in the generation manifest because a template can weaken future generated contracts.

Approved profile changes are recorded as explicit control-plane evidence under `contract/design/approvals/*.json`. Approval files are protected like the profile and manifest. They do not prove human identity cryptographically in v1; they make the review state machine auditable and give hooks/agents a concrete object to check. A future signed-approval mode can strengthen this without changing the profile model.

The first version must also enforce source-root ownership. Every file under `project.source_roots` must be either:

- owned by exactly one design context/module,
- explicitly ignored by a profile ignore pattern, or
- explicitly declared as shared kernel / external adapter code.

Unowned or ambiguously owned source files are blocking design-profile violations. Without this, an agent can bypass the approved model by moving code into an unmodeled directory.

There are two related but different maps:

- The design ownership map covers every source file under `project.source_roots` exactly once.
- Generated architecture declarations are enforcement views. Two separate architecture declarations may reuse the same path to check different questions, but each single architecture declaration must avoid overlapping module globs.

## 4. Design Profile Schema

The profile should be YAML for readability and `js-yaml` already exists in `@stele/cli`. Internally it should be parsed into a typed object and validated before generation.

Minimal v1 example:

```yaml
schema_version: 1
kind: stele-design-profile
profile_id: ddd-typedriven
created_at: "2026-05-19T00:00:00.000Z"
updated_at: "2026-05-19T00:00:00.000Z"

decisions:
  - id: q1-bounded-contexts
    question_id: Q1
    selected_option: by_business_function
    rationale: Billing and customer concepts use different language and release cadence.
    approved_by: human
    approved_at: "2026-05-19T00:00:00.000Z"
  - id: q2-billing-customer-acl
    question_id: Q2
    selected_option: anti_corruption_layer
    rationale: Billing may depend on customer identity concepts but must not couple to customer internals.
    approved_by: human
    approved_at: "2026-05-19T00:00:00.000Z"
  - id: q10-aggregate-complexity
    question_id: Q10
    selected_option: explicit_core_limits
    rationale: Core aggregates need reviewable size and complexity budgets.
    approved_by: human
    approved_at: "2026-05-19T00:00:00.000Z"
  - id: q4-domain-model-layering
    question_id: Q4
    selected_option: domain_model
    rationale: Billing and Customer use explicit DDD layers; dependencies must flow inward toward domain concepts.
    approved_by: human
    approved_at: "2026-05-19T00:00:00.000Z"
  - id: q18-type-driven
    question_id: Q18
    selected_option: explicit_core_types
    rationale: Core identity and value-object types are enforced only where exact symbols are declared.
    approved_by: human
    approved_at: "2026-05-19T00:00:00.000Z"

project:
  language: typescript
  source_roots:
    - src
  ignore:
    - src/generated/**/*
    - src/**/*.spec.ts
  tsconfig: tsconfig.json

ddd:
  bounded_context_strategy: by_business_function
  contexts:
    - id: billing
      decision_ref: q1-bounded-contexts
      name: Billing
      subdomain_type: core
      root: src/billing
      architecture_style: domain_model
      architecture_style_decision_ref: q4-domain-model-layering
      layers:
        api: src/billing/api/**/*.ts
        application: src/billing/application/**/*.ts
        domain: src/billing/domain/**/*.ts
        infrastructure:
          - src/billing/infrastructure/persistence/**/*.ts
          - src/billing/infrastructure/messaging/**/*.ts
      aggregate_roots:
        - id: invoice
          decision_ref: q10-aggregate-complexity
          class: Invoice
          target: src/billing/domain/invoice/Invoice.ts::Invoice
          metrics:
            sloc: { ideal: 220, max: 360 }
            public-method-count: { ideal: 12, max: 20 }
            max-cyclomatic: { ideal: 8, max: 12 }
    - id: customer
      decision_ref: q1-bounded-contexts
      name: Customer
      subdomain_type: supporting
      root: src/customer
      architecture_style: domain_model
      architecture_style_decision_ref: q4-domain-model-layering
      layers:
        public: src/customer/public/**/*.ts
        application: src/customer/application/**/*.ts
        domain: src/customer/domain/**/*.ts
        infrastructure: src/customer/infrastructure/**/*.ts

  shared_kernels:
    - id: shared-domain
      decision_ref: q1-bounded-contexts
      paths:
        - src/shared/**/*.ts

  integrations:
    - from: billing
      to: customer
      decision_ref: q2-billing-customer-acl
      pattern: anti_corruption_layer
      adapter_module: src/billing/infrastructure/customer-acl/**/*.ts

  domain_model_style: rich
  entity_mutability: immutable
  error_handling: result
  aggregate_reference_rule: id_only
  repository_location: domain_layer
  repository_pattern: one_per_aggregate
  query_constraints:
    no_find_all: true
    require_pagination: true
    require_filter: true

  core_invariants:
    - id: invoice_total_non_negative
      description: Invoice total must never be negative.
      evolvability: never
      status: pending
      enforcement:
        kind: scenario-required

type_driven:
  enabled: true
  decision_ref: q18-type-driven
  branded_ids:
    mode: core_ids_only
    declarations:
      - id: invoice-id
        decision_ref: q18-type-driven
        type_name: InvoiceId
        type_target: src/billing/domain/invoice/ids.ts::InvoiceId
      - id: customer-id
        decision_ref: q18-type-driven
        type_name: CustomerId
        type_target: src/customer/public/ids.ts::CustomerId
    entity_id_map:
      - aggregate: invoice
        id_type: InvoiceId
  adt:
    mode: core_entities_only
    entities:
      - name: Invoice
        type_target: src/billing/domain/invoice/InvoiceState.ts::InvoiceState
  smart_constructors:
    mode: all_value_objects
    value_objects:
      - id: money
        decision_ref: q18-type-driven
        class_target: src/shared/domain/Money.ts::Money
        factory_methods: [parse, create]
      - id: email-address
        decision_ref: q18-type-driven
        class_target: src/shared/domain/EmailAddress.ts::EmailAddress
        factory_methods: [parse]
  type_state:
    mode: core_state_machines_only
    state_machines:
      - name: Invoice
        api_target: src/billing/domain/invoice/InvoiceState.ts::InvoiceState
  runtime_validation:
    tool: zod
    schemas: []

toolchain_contracts:
  typescript_config:
    decision_ref: q18-type-driven
    required_options:
      strict: true
      exactOptionalPropertyTypes: true
      noUncheckedIndexedAccess: true
  typescript_diagnostics:
    enabled: true
    command: pnpm tsc --noEmit --pretty false --project tsconfig.json

toolchain:
  typescript:
    strict: true
    exact_optional_property_types: true
    no_unchecked_indexed_access: true
  eslint:
    enabled: true
    config: eslint.config.mjs
```

Validation rules:

- `schema_version` must be recognized.
- `project.language` is `typescript` in v1.
- Every generated rule must trace to a stable decision id. Array-index provenance such as `/ddd/contexts/0` is not stable enough.
- A `decision_ref` may be declared on a parent profile section and inherited by children, but the resolved generated rule must record the exact effective decision id.
- Choices that create separate hard rules, such as context ownership (Q1), integration pattern (Q2), layer style (Q4), aggregate complexity (Q10), and type-driven targets (Q18), should have distinct decision ids. The manifest may group multiple generated rules under one decision, but it must not hide a Q4 layer rule behind a generic Q1 context decision.
- Context ids, aggregate ids, branded type ids, and invariant ids must be stable identifiers.
- All paths must be project-relative and must not contain `..`.
- Context roots must not overlap unless explicitly declared as shared kernel.
- Every source file under `project.source_roots` must be owned by exactly one context/module or explicitly ignored.
- Every integration `from` and `to` must reference existing contexts.
- Layer, integration adapter, shared-kernel, and generated module globs must be disjoint after expansion within the same enforcement view. A broad layer glob must be split or narrowed before an adapter module can be generated as a separate enforceable module.
- Every aggregate target must follow the existing `path.ts::ClassName` format.
- Every Type-Driven hard check must have explicit symbol or path targets. Naming conventions such as `*Id` may create advisory notices, but not blocking contract violations.
- `core_invariants[*]` must use `status: pending | enforced`.
  - `pending` entries are visible to agents but non-blocking.
  - `enforced` entries must reference a real executable artifact through `rule_ref`, `scenario_ref`, `checker_ref`, or `external_tool_ref`.
  - `design check` must fail if an `enforced` invariant reference does not resolve.

## 5. Commands

### 5.1 `stele design init`

Purpose: create `contract/design/profile.yaml` from interactive answers or a non-interactive answers file.

Forms:

```text
stele design init --preset ddd-typedriven
stele design init --preset ddd-typedriven --answers path/to/answers.yaml
stele design init --preset ddd-typedriven --dry-run
```

Behavior:

- Refuses to overwrite an existing profile unless `--replace` is passed.
- `--replace` is treated as a protected contract change and prints review guidance.
- Writes the profile only; generation is a separate step unless `--generate` is explicitly passed.
- Does not ask irrelevant questions. For example Q2 appears only when more than one context exists.
- Supports per-context and per-aggregate repeated answers.

### 5.2 `stele design generate`

Purpose: compile profile into generated contracts, manifest provenance, and toolchain check metadata.

Forms:

```text
stele design generate
stele design generate --dry-run
stele design generate --force --reason "approved design profile update"
```

Behavior:

- Reads `contract/design/profile.yaml`.
- Generates `contract/generated/ddd-typedriven.stele`.
- Ensures `contract/main.stele` imports the generated contract file.
- Writes `contract/design/generation-manifest.json`.
- Validates the resulting contract with `loadContract`.
- Does not run `stele lock`, `baseline-update`, or `generate` for ordinary contract tests. Those are separate approval steps.
- Refuses to overwrite generated outputs if their current hash does not match the manifest.
- `--force --reason` is only an execution parameter after a human-approved design diff exists. A reason string is not approval by itself.

### 5.3 `stele design approve`

Purpose: write explicit approval evidence for reviewed profile changes before regeneration.

Forms:

```text
stele design approve --from main --reason "approved DDD boundary change"
```

`stele design approve` is the explicit approval-record writer:

- Computes `design diff` against the last approved profile hash, or a supplied base ref.
- Writes `contract/design/approvals/<timestamp>-<short-hash>.json`.
- Records `base_profile_sha256`, `approved_profile_sha256`, `diff_classification`, `affected_generated_rules`, `affected_source_scope`, `reason`, `approved_by`, and `approved_at`.
- Refuses to approve generated-output drift by itself; generated files must still match the approved profile through `design generate`.
- Is intended for human review. Hooks and agent guidance must tell agents to ask the user before creating or changing approval files.

### 5.4 `stele design check`

Purpose: verify profile integrity and generated-output drift.

Checks:

- Profile schema is valid.
- Profile approvals and decision ids are present for protected choices.
- Generated `.stele` file exists and matches manifest hash.
- Manifest records and verifies profile hash, approved profile hash, approval record id/hash, generator hash, template hash when applicable, generated output hash, and stable rule provenance.
- `contract/main.stele` imports the generated file.
- All generated rule ids still exist.
- Toolchain config files referenced by the profile exist.
- `project.language: typescript` is consistent with the Stele config when generated TypeScript tests are expected; otherwise `stele check` architecture evaluation remains the hard enforcement path.
- Source-root ownership has no unowned or ambiguous modeled files.
- Protected globs include `contract/design/**/*`, future template override paths, and `contract/generated/ddd-typedriven.stele`.

This command is also a stage inside default `stele check` before the first usable release. The standalone command is for diagnosis; it is not the only enforcement path. Stop hooks already run `stele check`, so design-profile drift must be visible there.

`stele design check --profile-only` is allowed before the first generation. It validates schema, paths, decisions, source ownership, protected-path configuration, and pending/enforced invariant references, but it does not require `generation-manifest.json` or generated `.stele` outputs yet. Default `stele design check` is full integrity mode once generation has happened.

### 5.5 `stele design explain`

Purpose: help agents and humans understand why a generated rule exists.

Forms:

```text
stele design explain context:billing
stele design explain rule:architecture.ddd.billing.domain.infrastructure
stele design explain type:InvoiceId
```

Output should include:

- Profile path and line if available.
- Generated rule path and line.
- Original decision question.
- Selected answer.
- Enforced mechanism.
- Suggested fix.
- Whether the rule is generated, human-authored, or external-tool-backed.

### 5.6 `stele design diff`

Purpose: compare two design profiles and classify the change.

Form:

```text
stele design diff --from main
```

Change classes:

- `additive`: new context, new aggregate, new branded id, new invariant proposal.
- `tightening`: stricter max metrics, stricter dependency rules, stricter TypeScript/ESLint rules.
- `weakening`: removed context, removed rule, relaxed dependency, disabled type-driven setting.
- `restructuring`: changed context root, moved aggregate target, changed integration pattern.

Weakening and restructuring changes should not be silently accepted by hooks. They should force agent guidance: produce evidence and ask the user for review.

`design diff` must classify changes at field level, not only at file level:

| Change | Default handling |
| --- | --- |
| Add pending invariant proposal | Agent may propose add-only; user review before enforcement. |
| Add new branded id declaration with explicit target | Agent may propose add-only; `design check` verifies no existing rule weakened. |
| Add new context or aggregate | Requires user review because it changes ownership and generated rules. |
| Add `allow-dependency` edge | Requires user review because it relaxes architecture. |
| Relax metric max / disable strict type option / remove source root | Weakening; block until user approval. |
| Move context root / aggregate target | Restructuring; block until user approval and impact report. |

Diff output must include affected generated rules and affected source-file scope.

Default `stele check` must not depend on a user remembering `--from main`. It should compare the current profile against the last approved profile hash recorded in `generation-manifest.json` and its linked approval record. A supplied base ref is useful for PR-style reports, but the default local Stop-hook path uses the manifest/approval chain.

### 5.7 `stele design propose`

Purpose: give agents an add-only path for new design knowledge without letting them edit `profile.yaml` directly.

Forms:

```text
stele design propose invariant --id invoice_total_non_negative --description "..." --evolvability never
stele design propose branded-id --type InvoiceId --target src/billing/domain/invoice/ids.ts::InvoiceId
```

Behavior:

- Writes proposals under `contract/design/proposals/*.yaml`.
- Treats proposals as command-owned control-plane files. Direct edits to proposals are protected; additive writes through this command are allowed only after validation.
- Refuses duplicate ids.
- Refuses modifications or removals of existing profile entries.
- Runs `design diff` to prove the proposal is additive and does not weaken generated rules.
- Does not regenerate or lock anything automatically.

## 6. Generation Mapping

The generator should classify every profile choice by enforceability. This avoids fake confidence.

| Question | Generated output | Enforcement level in v1 |
| --- | --- | --- |
| Q1 bounded contexts | `architecture` modules plus source-root ownership coverage | Hard, via architecture dependency graph and ownership check |
| Q2 integration patterns | `allow-dependency` plus adapter module for ACL/OHS/public boundary | Hard for import direction; semantic translation quality remains human-owned |
| Q3 subdomain type | Metadata in profile and generated comments/provenance | Advisory in v1 |
| Q4 architecture style | Per-context layer modules and allowed dependencies | Hard for dependency direction |
| Q5 domain object style | Profile guidance and future TypeScript shape checks | Partial; not hard until TS shape adapter exists |
| Q6 mutability | Profile guidance plus TS AST checks for `readonly` after adapter | Partial in v1; hard only after the native TS shape stage has explicit targets |
| Q7 error handling | TypeScript compiler/lint/AST checks for Result-returning business APIs | Partial in v1; hard only where signatures are declared |
| Q8 entity/value object criterion | Profile model and generated type guidance | Partial; hard only for declared classes |
| Q9 aggregate boundary principle | Profile metadata and aggregate modules | Partial; hard for import boundaries, not for conceptual correctness |
| Q10 aggregate complexity limits | Existing `core-node` declarations | Hard for target classes after missing-target gap is fixed |
| Q11 aggregate references | Architecture rules blocking direct aggregate imports; TS AST check for entity-type fields later | Hard for imports, partial for type fields |
| Q12 cross-aggregate rule location | Architecture modules for domain service/process manager/application service | Hard for dependency direction, partial for rule semantics |
| Q13 repository interface layer | Architecture modules and future TS shape check for repository declarations | Hard for path/import, partial for interface shape |
| Q14 aggregate-repository relation | Architecture rules blocking direct ORM access from domain/application; future TS shape checks | Partial |
| Q15 CQRS | Generated modules and dependencies for read/write side separation | Hard for dependency direction only |
| Q16 repository method constraints | TS shape checker for explicitly declared repository targets | Partial only after the native TS shape stage; naming/shape checks do not prove semantic query boundedness |
| Q17 core invariants | Pending profile entries or references to real executable rules | No fake generation; hard only when `status: enforced` resolves to a real rule/checker/scenario/tool |
| Q18 branded IDs | Explicit branded type declarations plus optional TS shape checks | Hard only for declared scopes/symbols in P2; suffix-based scans are advisory |
| Q19 ADT/sum types | Type declarations, tsc, `switch-exhaustiveness-check` | Hard where ADTs are declared and toolchain checks are enabled |
| Q20 smart constructors | Explicit value-object targets and configurable factory method checks | Hard only for declared targets in P2 |
| Q21 type-state | Type declarations and tsc compile checks for declared state APIs | Partial; full semantic checking is not v1 |
| Q22 runtime validation | Zod/io-ts guidance plus contract tests for declared boundary schemas | Advisory in v1; hard only where schema targets and fixtures/tests are declared |

The rule is: if Stele cannot enforce a choice, the generator must label it as advisory or pending. It must not generate hollow tests just to make the output look complete.

## 7. Generated DSL Examples

### 7.1 Context and Layer Architecture

Generated from a `billing` bounded context using Domain Model style:

```lisp
(architecture "ddd-billing"
  (lang typescript)
  (tsconfig "tsconfig.json")
  (description "Generated from contract/design/profile.yaml: billing context must preserve DDD layer direction.")

  (module billing-api
    (path "src/billing/api/**/*.ts"))
  (module billing-application
    (path "src/billing/application/**/*.ts"))
  (module billing-domain
    (path "src/billing/domain/**/*.ts"))
  (module billing-infrastructure
    (path "src/billing/infrastructure/**/*.ts"))
  (module billing-shared
    (path "src/billing/shared/**/*.ts"))

  (layer presentation billing-api)
  (layer application billing-application)
  (layer domain billing-domain)
  (layer infrastructure billing-infrastructure)
  (layer shared billing-shared)

  (allow-dependency billing-api billing-application billing-shared)
  (allow-dependency billing-application billing-domain billing-shared)
  (allow-dependency billing-infrastructure billing-application billing-domain billing-shared)
  (allow-dependency billing-domain billing-shared)

  (deny-cycles)
  (fix "Move the dependency behind an allowed DDD layer boundary, or ask the user to approve a design-profile change."))
```

No `(allow-dependency billing-shared)` is generated because the current parser requires at least one target. Omitting it means `billing-shared` cannot depend on other declared modules in this architecture view; external packages and unmodeled files are not governed by this architecture declaration. Project-internal unmodeled files are handled by design source-root ownership checks.

### 7.2 ACL Integration

If `billing` can use `customer` only through an anti-corruption layer:

```lisp
(architecture "ddd-context-map"
  (lang typescript)
  (tsconfig "tsconfig.json")
  (description "Generated context map: cross-context dependencies must follow declared integration patterns.")

  (module billing-application
    (path "src/billing/application/**/*.ts"))
  (module billing-domain
    (path "src/billing/domain/**/*.ts"))
  (module billing-infrastructure
    (path "src/billing/infrastructure/persistence/**/*.ts")
    (path "src/billing/infrastructure/messaging/**/*.ts"))
  (module billing-customer-acl
    (path "src/billing/infrastructure/customer-acl/**/*.ts"))
  (module customer-public
    (path "src/customer/public/**/*.ts"))
  (module customer-internal
    (path "src/customer/domain/**/*.ts")
    (path "src/customer/application/**/*.ts")
    (path "src/customer/infrastructure/**/*.ts"))

  (allow-dependency billing-application billing-domain billing-customer-acl)
  (allow-dependency billing-infrastructure billing-domain)
  (allow-dependency billing-customer-acl customer-public)

  (deny-cycles)
  (fix "Use the declared ACL module instead of importing the customer context directly."))
```

This can block an agent from importing `src/customer/domain/Customer.ts` directly inside `src/billing/application`. It cannot prove the ACL translation is semantically correct; that remains a human-authored invariant or scenario.

The generator must not emit overlapping module globs inside one architecture declaration. If overlap is unavoidable, `design check` must report ambiguous ownership as a configuration violation before architecture evaluation runs. Current runtime behavior assigns ambiguous files to the first matching module, which is not safe enough for generated DDD rules.

The layer architecture example and ACL integration example are two separate enforcement views. Reusing `src/billing/application/**/*.ts` across those two declarations is allowed because each declaration has disjoint modules internally; the global source ownership map still belongs to the design profile and must assign each source file exactly once.

### 7.3 Aggregate Complexity

Generated from Q10:

```lisp
(core-node "billing-invoice-aggregate"
  (lang typescript)
  (role business-core-service)
  (target "src/billing/domain/invoice/Invoice.ts::Invoice")
  (description "Generated from design profile: Invoice aggregate must remain reviewable.")
  (rationale "Invoice protects core billing invariants; complexity drift makes agent changes risky.")
  (metric sloc (ideal 220) (max 360))
  (metric public-method-count (ideal 12) (max 20))
  (metric max-cyclomatic (ideal 8) (max 12)))
```

## 8. Type-Driven Enforcement

Type-driven support should have three layers. They intentionally do different jobs.

### 8.1 TypeScript Config Policy Stage

Some type-driven decisions are configuration contracts, not compiler diagnostics. `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` should be checked by reading the resolved `tsconfig`, not by waiting for a particular `TSxxxx` error.

Implementation:

- Add a shared TypeScript config loader that uses `ts.readConfigFile` plus `ts.parseJsonConfigFileContent`.
- Support `extends`, relative `baseUrl`, `paths`, `include`, `files`, and project references well enough for architecture and shape checks to share the same resolved config.
- Emit Stele violations such as `typedriven.typescript.config.strict` when a required option is missing or explicitly disabled.
- Run this stage before diagnostic ingestion so setup errors are clear.

### 8.2 Compiler Diagnostic Stage

`stele check` should gain a toolchain stage that can run project-local TypeScript checks:

```text
pnpm tsc --noEmit --pretty false --project tsconfig.json
```

Implementation:

- Add `packages/cli/src/toolchain/typescript.ts`.
- Resolve commands from project-local package managers first (`pnpm exec`, `npm exec`, local `node_modules/.bin`), then PATH.
- Parse `tsc --pretty false` diagnostic text into Stele violations. ESLint is the JSON-ingestion path; `tsc` is not JSON unless a future compiler API mode is added.
- Rule ids should map to generated toolchain rules, for example `typedriven.typescript.diagnostic.TS2322`.

The stage must not report "tsc failed" as an opaque process error when locations are parseable. It should report file, line, column, diagnostic code, cause, and fix guidance. Tests must cover Windows paths, multi-line diagnostics, and non-diagnostic process failures.

### 8.3 ESLint Stage

For type-driven choices, Stele should ingest ESLint JSON output:

```text
pnpm eslint --format json "src/**/*.{ts,tsx}"
```

Profile-required external rules may include:

- `@typescript-eslint/no-explicit-any`
- `@typescript-eslint/no-non-null-assertion`
- `@typescript-eslint/switch-exhaustiveness-check`
- `@typescript-eslint/no-unsafe-assignment`
- `@typescript-eslint/no-unsafe-return`

The profile should record whether Stele owns the ESLint config or only validates that the project config enables the required rules. The current Stele repo does not depend on ESLint or `@typescript-eslint`, so v1 should treat ESLint as project-local ingestion:

- If ESLint is configured, parse JSON output and convert diagnostics tied to profile decisions into Stele violations.
- If ESLint is missing but a profile requires it, report an actionable setup violation or mark the rule advisory based on profile severity.
- Diagnostics from generic lint rules that are not tied to a profile decision should not become blocking Stele contract violations.

### 8.4 Native TS Shape Stage

Some DDD/type-driven constraints are not normal lint rules. They need a small TypeScript AST adapter inside Stele.

Create `packages/cli/src/typescript-shape/` with focused checks:

| Check | Input from profile | Detection |
| --- | --- | --- |
| Branded ID use | Explicit branded type declarations, entity-id map, and target scopes | Build a `ts.Program` and use `TypeChecker` symbol identity. Suffix-based `*Id` scans are advisory only. |
| Repository method policy | Explicit repository interface/class targets and configurable method constraints | Parse declared targets; flag forbidden method names and obvious unbounded return shapes. This does not prove semantic query boundedness. |
| Smart constructor | Explicit value-object class targets and configured factory names | Require private/protected constructor and declared static factory methods such as `parse`, `create`, `of`, or project-configured names. |
| Result error style | Explicit method/interface targets plus configured Result type symbol | Check return types only for declared APIs. `throw` detection is best-effort AST guidance because TypeScript has no checked exceptions. |
| Aggregate reference by ID | Aggregate-root target map and id-type map | Use `TypeChecker` symbol identity to flag declared aggregate-to-aggregate fields/params that use root type instead of id type. |

This should be a new TS-specific stage, not an extension of current Python-only `code-shape`.

V1 should not hard-enforce every row above. The minimum useful Type-Driven v1 is:

1. TypeScript config policy validation.
2. TypeScript diagnostic ingestion.
3. Optional project-local ESLint JSON ingestion.
4. At most one native shape check with explicit targets, preferably smart constructor or declared branded-id usage.

Result style, repository semantic query safety, aggregate-reference semantic correctness, and Zod runtime validation should stay advisory/pending until the profile can declare exact symbols, scopes, schemas, and fixtures.

## 9. Profile Evolution and Governance

Design choices are contract material. Weakening them is not a normal edit.

### 9.1 Protected Files

Extend default protected globs:

```text
contract/design/**/*
contract/design/proposals/**/*
contract/generated/ddd-typedriven.stele
contract/templates/ddd-typescript/**/*  # future, only if template overrides are introduced
```

`contract/design/proposals/**/*` is protected against direct editor writes, but `stele design propose` may create new proposal files after proving the change is add-only. This keeps the "agents can add knowledge" path without allowing quiet profile weakening.

These defaults must be synchronized across:

- `packages/cli/src/config/defaults.ts`
- Claude plugin fallback protected patterns
- `@stele/agent-hooks` config types and tests
- `stele design check`, which should fail if a project config omits required control-plane protection

### 9.2 Provenance

`generation-manifest.json` should contain:

```json
{
  "schema_version": 1,
  "generator": {
    "package": "@stele/cli",
    "version": "0.1.0",
    "git_sha": "abc123",
    "content_sha256": "..."
  },
  "preset": "ddd-typedriven",
  "profile_path": "contract/design/profile.yaml",
  "profile_sha256": "...",
  "approved_profile_sha256": "...",
  "approval": {
    "path": "contract/design/approvals/2026-05-19T000000Z-a1b2c3d4.json",
    "sha256": "...",
    "diff_classification": "additive",
    "approved_by": "human",
    "approved_at": "2026-05-19T00:00:00.000Z"
  },
  "templates": [],
  "outputs": [
    {
      "path": "contract/generated/ddd-typedriven.stele",
      "sha256": "...",
      "rules": [
        {
          "id": "ddd-billing",
          "kind": "architecture",
          "origins": [
            {
              "decision_id": "q1-bounded-contexts",
              "profile_anchor": "ddd.contexts.billing",
              "question_id": "Q1",
              "selected_option": "by_business_function"
            },
            {
              "decision_id": "q4-domain-model-layering",
              "profile_anchor": "ddd.contexts.billing.architecture_style",
              "question_id": "Q4",
              "selected_option": "domain_model"
            }
          ],
          "profile_location": {
            "path": "contract/design/profile.yaml",
            "line": 23
          },
          "enforcement_level": "hard",
          "source": "generated"
        }
      ]
    }
  ]
}
```

This lets `stele explain`, `stele rules --json`, and `stele agent-context` tie generated rules back to human design decisions. A generated rule may have multiple origins when one architecture declaration enforces several approved choices, such as Q1 ownership plus Q4 layer direction. `design check` must fail if the profile, approval record, generator, future template, output, or rule provenance hash changes without an approved design diff.

### 9.3 Change Classification

`stele design diff` should classify profile changes:

- Additions: allowed for agents only when add-only and no existing rule is weakened.
- Tightening: allowed only with explicit reason because it can block existing code.
- Weakening: must ask the user.
- Restructuring: must ask the user and should include impact analysis.

This mirrors the current contract philosophy: agents may help add knowledge, but modifying/removing constraints is human-reviewed.

`stele check` must run design integrity before ordinary rule checks:

1. Validate profile schema and protected path coverage.
2. Validate source-root ownership.
3. Validate profile/generator/template/output hashes against the manifest.
4. Classify design diff against the approved profile hash recorded in the manifest/approval chain; optionally also render a base-ref comparison for PR reports.
5. Emit blocking violations for unapproved weakening, restructuring, drift, or missing enforced invariant references.

`maintenance-summary` should include profile hash, manifest status, recent design diff classification, and whether the agent should propose an addition or ask the user for review.

### 9.4 No Fake Invariants

Q17 must not generate runnable placeholder tests. If the user lists "Invoice total cannot be negative" but provides no scenario/checker, the generator should create a non-runnable design-profile entry plus a clear action:

```text
PENDING INVARIANT invoice_total_non_negative:
  needs one of:
  - human-authored CDL assert over existing state
  - scenario-backed invariant
  - checker implementation
```

Stele can also produce an add-only proposal template, but it must not mark the invariant as enforced until a real check exists. When `status: enforced`, the profile must include a resolvable reference:

```yaml
core_invariants:
  - id: invoice_total_non_negative
    description: Invoice total must never be negative.
    evolvability: never
    status: enforced
    enforcement:
      kind: stele-rule
      rule_ref: INVOICE_TOTAL_NON_NEGATIVE
```

## 10. Agent Understanding

This feature only works if agents can understand the generated rules without opening five files manually.

Extend `stele agent-context`:

- Add `design_profile` summary:
  - profile path
  - profile hash
  - manifest hash status
  - contexts
  - selected DDD style
  - type-driven settings
- Add `generated_rule_sources` mapping from rule id to stable profile anchor, decision id, enforcement level, and source type.
- For `--focus <file>`, include:
  - owning context/module
  - allowed dependencies
  - relevant branded ids/value objects
  - core-node metric boundaries if the file is a target

Human markdown output should tell the agent:

```text
This file belongs to billing-domain.
Allowed dependencies: billing-shared only.
Direct imports from billing-infrastructure or customer-internal violate the design profile.
If the design profile is wrong, investigate and ask the user; do not edit generated contracts directly.
```

Extend `stele explain`:

- `stele explain architecture:<id>` already exists.
- Add `stele design explain ...` for profile-origin explanation.
- `stele why` should recognize toolchain/type-shape rule kinds and give repair guidance.

Machine-readable outputs must share a stable provenance schema across `rules --json`, `agent-context --json`, `design explain --json`, `why --json`, and `check --json`:

```json
{
  "rule_id": "architecture.ddd-billing.billing-application.customer-internal",
  "origin": {
    "source": "generated",
    "profile_path": "contract/design/profile.yaml",
    "profile_anchor": "ddd.contexts.billing.integrations.customer",
    "profile_line": 42,
    "decision_id": "q2-billing-customer-acl",
    "question_id": "Q2",
    "selected_option": "anti_corruption_layer",
    "enforcement_level": "hard"
  },
  "agent_guidance": {
    "default_action": "repair-source",
    "when_to_ask_user": "If the integration pattern is wrong or a new dependency direction is genuinely required."
  }
}
```

Golden fixture tests must cover this JSON schema for release-blocking machine outputs. Human markdown can change more freely; machine contracts should not.

## 11. Implementation Plan

### Phase 0: Fix Existing Enforcement Gaps

Files:

- `packages/cli/src/architecture-runtime.ts`
- `packages/cli/src/architecture/module-map.ts`
- `packages/cli/src/architecture/typescript-extractor.ts`
- `packages/cli/src/architecture/stage.ts`
- `packages/architecture-core/src/typescript-extractor.ts`
- `packages/architecture-core/src/graph.ts`
- `packages/backend-typescript/src/architecture-renderer.ts`
- `packages/cli/src/commands/check.ts`
- `packages/cli/src/complexity/evaluate.ts`
- `packages/cli/src/commands/rules.ts`
- tests under `packages/cli/tests` and `packages/backend-typescript/tests`

Required changes:

1. Propagate `tsconfig` from DSL to generated tests and CLI architecture runtime.
2. Replace raw tsconfig parsing with a shared `parseJsonConfigFileContent` loader.
3. Surface unresolved internal imports and ambiguous module ownership inside architecture evaluation as visible violations or blocking configuration errors.
4. Surface cycle violations as Stele violations with `rule_kind: "architecture_cycle"`.
5. Make `--architecture-only` and `--complexity-only` actually skip unrelated stages.
6. Treat missing core-node file/class as blocking configuration violations.
7. Index core-node declarations in `rules --json` and `agent-context`.
8. Carry architecture `fix` / `description` into check violations and generated test failure messages.
9. Decide and document whether `layer` and `public-entry` are executable in v1; if not, mark them metadata/advisory and do not rely on them for hard enforcement.
10. Add tests proving the above. Existing cycle fixture currently only asserts that `violations` is defined; it must assert an actual cycle violation.

Acceptance:

- A TypeScript fixture with path aliases detects a forbidden import.
- A fixture with overlapping module globs fails before dependency evaluation.
- A fixture with an unresolved project-internal import does not silently pass.
- `stele check --architecture-only` runs only integrity + architecture stages.

### Phase 1: Design Profile Core

Files to create:

- `packages/cli/src/design-profile/types.ts`
- `packages/cli/src/design-profile/load.ts`
- `packages/cli/src/design-profile/validate.ts`
- `packages/cli/src/design-profile/hash.ts`
- `packages/cli/src/commands/design.ts`
- `packages/cli/tests/design-profile.test.ts`

Files to modify:

- `packages/cli/src/index.ts`
- `packages/cli/src/config/defaults.ts`
- Claude plugin fallback protected-pattern config
- `@stele/agent-hooks` config types and tests

Responsibilities:

- Parse YAML.
- Validate schema and path safety.
- Validate consistency between design profile language and Stele config backend settings.
- Discover files under `project.source_roots` and enforce the design ownership map; this is profile-level validation, not architecture-runtime validation.
- Produce precise errors with profile path and field name.
- Add working `stele design init`, `check`, `explain`, `diff`, and `propose` commands for a minimal profile.

Acceptance:

- A real profile can be parsed, validated, explained, and checked with `stele design check --profile-only` before generated contracts exist.
- Invalid ownership, path traversal, missing approval metadata, and unresolved enforced invariant refs fail with precise profile locations.
- A TypeScript profile either has compatible TypeScript/Vitest backend config for generated tests or reports that only CLI architecture-stage enforcement is active.

### Phase 2: DDD Contract Generator

Files to create:

- `packages/cli/src/design-generator/ddd.ts`
- `packages/cli/src/design-generator/render-stele.ts`
- `packages/cli/src/design-generator/manifest.ts`
- `packages/cli/tests/design-generator-ddd.test.ts`

Files to modify:

- `packages/cli/src/commands/check.ts`
- `packages/cli/src/commands/rules.ts`
- `packages/cli/src/commands/agentContext.ts`
- `packages/cli/src/config/defaults.ts`
- `scripts/verify-packed-adoption.mjs`

Responsibilities:

- Compile contexts/layers/integrations into `architecture` declarations.
- Compile aggregate metric limits into `core-node` declarations.
- Write `contract/generated/ddd-typedriven.stele`.
- Maintain `generation-manifest.json`.
- Add import to `contract/main.stele` safely.
- Refuse manual generated-file drift.
- Wire design integrity into default `stele check`.

Acceptance:

- Profile -> generated contract -> `loadContract` -> `stele check` succeeds for a valid TypeScript DDD fixture.
- Cross-boundary import, generated-output drift, unowned source file, and missing manifest hash each fail through `stele check --json`.
- Generated `test_arch_*.ts` files are executed by Vitest in at least one passing and one failing TypeScript fixture, not only rendered.
- `stele agent-context --json --focus` returns the profile decision behind the generated architecture rule.

### Phase 3: Toolchain Ingestion

Files to create:

- `packages/cli/src/toolchain/types.ts`
- `packages/cli/src/toolchain/command-resolver.ts`
- `packages/cli/src/toolchain/tsconfig-policy.ts`
- `packages/cli/src/toolchain/typescript.ts`
- `packages/cli/src/toolchain/eslint.ts`
- `packages/cli/tests/toolchain-typescript.test.ts`
- `packages/cli/tests/toolchain-eslint.test.ts`

Responsibilities:

- Resolve project-local commands.
- Validate required TypeScript config options via the shared tsconfig loader.
- Run or dry-run toolchain commands.
- Parse `tsc --pretty false` diagnostic text and ESLint JSON output.
- Convert diagnostics into `ViolationReport`.
- Wire toolchain stage into `stele check` only when profile enables it, and into `why` guidance.

Acceptance:

- Missing strict TS config option fails as `typescript-config-policy`.
- A real `TSxxxx` diagnostic becomes a precise Stele violation.
- A passing ESLint JSON fixture with no relevant diagnostics produces no Stele violation.
- A real ESLint JSON diagnostic tied to a profile-required rule becomes a precise Stele violation.
- Missing project-local ESLint gives actionable setup output instead of a generic process failure.

### Phase 4: Native TypeScript Shape Checks

Files to create:

- `packages/cli/src/typescript-shape/types.ts`
- `packages/cli/src/typescript-shape/program.ts`
- `packages/cli/src/typescript-shape/branded-ids.ts`
- `packages/cli/src/typescript-shape/smart-constructors.ts`
- `packages/cli/tests/typescript-shape.test.ts`

Responsibilities:

- Use the TypeScript compiler API, not regex.
- Use `ts.createProgram` and `TypeChecker` with the project's resolved `tsconfig`.
- Evaluate only profile-declared targets and symbols.
- Emit specific file/line/cause/fix violations.

Acceptance:

- V1 ships at most one native shape rule with pass/fail fixtures and JSON report assertions.
- Convention-only detections remain advisory and do not block.

### Phase 5: Agent Context and Documentation

Files to modify:

- `packages/cli/src/commands/agentContext.ts`
- `packages/cli/src/commands/explain.ts`
- `packages/cli/src/commands/why.ts`
- `docs/spec/cdl.md`
- `docs/guides/claude-code-plugin.md`
- `docs/contributing/testing.md`
- `docs/contributing/release.md`

Responsibilities:

- Add design-profile context to agent output.
- Explain generated rule provenance.
- Document the rule: add-only design knowledge is encouraged; weakening/restructuring requires user review.
- Document packed adoption and release gates for the design-profile feature.
- Update the release package matrix so it matches the publish script, including TypeScript architecture packages used by this flow.

## 12. Testing Strategy

This feature needs tests that prove enforcement, not tests that only snapshot generated strings.

Required test groups:

1. Profile parser:
   - valid minimal profile
   - invalid path traversal
   - overlapping contexts
   - unowned source file under source root
   - missing referenced context
   - unsupported language
   - enforced invariant reference missing

2. DDD generator:
   - generated architecture uses current DSL syntax
   - generated core-node target is valid
   - generated contract loads through `loadContract`
   - import is added to `contract/main.stele`
   - manual generated drift is rejected
   - generator hash or template hash drift is rejected

3. Architecture enforcement:
   - direct cross-context import fails
   - allowed ACL import passes
   - generated `test_arch_*.ts` executes under Vitest for TypeScript projects
   - cycle fails when `deny-cycles` is true and reports `rule_kind: "architecture_cycle"` with modules and edge files
   - tsconfig path alias import resolves correctly
   - unresolved internal import is visible and does not silently pass

4. Complexity enforcement:
   - aggregate over max fails
   - above ideal produces notice
   - missing target fails

5. Toolchain ingestion:
   - missing required tsconfig option becomes a config-policy violation
   - tsc diagnostic becomes a Stele violation with file/line/code
   - ESLint JSON with no relevant diagnostics passes cleanly
   - ESLint JSON diagnostic becomes a Stele violation
   - command missing produces actionable setup error

6. TypeScript shape checks:
   - exactly one v1 hard native shape rule has a passing fixture, failing fixture, and precise JSON report assertion
   - advisory convention scans do not block `stele check`
   - broader repository, Result-style, aggregate-reference, and Zod checks remain pending/advisory until explicit targets and fixtures exist

7. Agent context:
   - focus file includes owning context and allowed dependencies
   - generated rule includes stable profile anchor and decision id
   - `design explain --json` prints source profile decision and generated rule
   - `stele why --json` preserves origin and fix guidance

8. Release acceptance / packed adoption:
   - pack and install every `@stele/*` package used by the TypeScript design flow into a clean TypeScript fixture, including `@stele/cli`, `@stele/core`, `@stele/architecture-core`, `@stele/backend-typescript`, and hook packages when the fixture exercises agent hooks.
   - run `stele design init`, `stele design generate`, `stele check --json --report-file`, and generated TypeScript architecture tests.
   - assert one passing project, one cross-boundary failure, one generated drift failure, and one `agent-context --json --focus` profile provenance output.
   - verify all Stele packages in the fixture resolve from the local tarballs, not registry or workspace fallbacks.

Machine-readable outputs must use golden fixtures where stability matters: `check --json`, `agent-context --json`, `design explain --json`, `why --json`, and `generation-manifest.json`. Generated source code should be tested semantically where possible rather than only snapshotting strings.

## 13. Non-Goals

Do not build these in the first implementation:

- Multi-language support beyond TypeScript.
- Visual DDD modeling UI.
- Automatic discovery of correct bounded contexts from source code.
- Semantic proof that a domain model is good.
- Automatic generation of business invariant tests from natural language.
- A full custom ESLint replacement.

## 14. Key Design Decisions

1. The design profile is the source of truth, not generated code.
2. Existing `architecture` and `core-node` DSL are the first enforcement target.
3. TypeScript-specific checks live in a new TS shape stage because current code-shape is Python-only.
4. Q17 business invariants are not generated as fake tests.
5. Generated rules need provenance so agents can understand and humans can review them.
6. Weakening or restructuring the profile is a human decision.
7. The first version supports TypeScript only.

## 15. Success Criteria

The first useful release is successful when this works end to end:

1. User runs `stele design init --preset ddd-typedriven`.
2. User commits `contract/design/profile.yaml`.
3. User runs `stele design generate`.
4. Stele generates architecture and core-node contracts.
5. An agent imports across an undeclared DDD boundary.
6. `stele check` fails with a precise architecture violation.
7. `stele agent-context --focus <file>` tells the agent which design decision it violated.
8. The agent can fix source code without editing generated contracts.
9. Manual drift in the design profile, generation manifest, generated contract, or source ownership map fails through the same default `stele check` path used by Stop hooks.
10. A packed local install of the full Stele package set used by the TypeScript flow can run the full flow in a clean fixture without relying on unpublished workspace paths, registry fallbacks, or workspace symlinks.

Anything less is just scaffolding. The value appears only when profile, generated contract, runtime check, and agent guidance form one loop.
