# Competitive Analysis for Stele

> Generated: 2026-05-08
> Stele v0.1 -- Contract tool for AI-assisted software delivery

## Executive Summary

Stele occupies a unique intersection of **custom DSL-defined contracts**, **auto-generated test artifacts**, **protected-state locking**, and **AI agent guardrails**. No single competitor spans all four dimensions. The nearest analogs exist in individual adjacent categories, but none integrate them into a unified workflow for AI-assisted code generation with contract enforcement.

---

## 1. Contract Testing / API Contracts

| Tool | Core Value | Overlap with Stele | Unique Feature Worth Adopting | Gap Stele Could Fill |
|------|-----------|--------------------|-------------------------------|---------------------|
| **Pact** (pact-foundation/pact) -- 2.2k stars, v2.x, MIT | Consumer-driven contract testing; verifies provider/consumer HTTP & async message exchanges via mock service + DSL. Supports gRPC, HTTP, async. Pact Broker manages contracts in CI/CD. **Pricing:** OSS core; PactFlow (premium managed broker). | Both define contracts as code and verify them in CI. Both use a custom DSL for contract expression. | Pact Broker promotion workflow (dev -> staging -> prod contract versioning). Contract matrix visualization. Verifying provider against all consumer contracts automatically. | Pact operates at the API integration layer. Stele operates at the application invariant layer -- Stele checks business rules, not HTTP contracts. No overlap here. |
| **Spring Cloud Contract** (spring-cloud/spring-cloud-contract) -- 730 stars, v4.x, Apache 2.0 | Consumer-driven contracts for Spring ecosystem. Generates tests, publishes contract assets, verifies producer/consumer compliance for HTTP and messaging. | Both generate test code from contract definitions. Both run in CI pipelines. | Consumer-driven workflow (consumer writes contract, producer verifies). Stub generation for consumer test isolation. | Java/Spring only. Stele targets Python + pytest, language-agnostic CDL. |
| **Schemathesis** (schemathesis/schemathesis) -- 3.3k stars, v3.x, GPL | Property-based API testing from OpenAPI/GraphQL specs. Generates test inputs from schema, detects server crashes and spec mismatches. Powered by Hypothesis. JUnit/HAR output. CI/CD integration. **Pricing:** OSS core; Schemathesis Cloud (commercial). | Both generate tests from a formal specification. Both use property-based approaches. Both run in CI. | Schema-driven test generation from OpenAPI/GraphQL. Edge-case discovery from spec-defined types. Report formats (Allure, HAR). | Schemathesis is API-level (HTTP requests/responses). Stele is application-level (business invariants). Different threat models. |
| **WireMock** (wiremock/wiremock) -- 7.2k stars, v3.x, Apache 2.0 | API mocking for test/development. Stub HTTP responses by URL/header/body patterns. Record & replay. Fault injection. Browser proxy. **Pricing:** OSS core free; Pro/Cloud (freemium + commercial). | Minimal direct overlap. Both can be used in CI/CD test pipelines. | Record-and-replay stub capture. Fault injection (delays, errors). Per-request conditional proxying. Stateful interaction simulation. | WireMock is a mock server, not a contract definition tool. Stele could potentially integrate WireMock stubs for scenario testing in the future. |

**Key Finding:** Contract testing tools operate at the API boundary. Stele operates at the application invariant boundary. This is a defensible differentiation -- they solve different problems and are complementary, not competitive.

---

## 2. Policy-as-Code / Infrastructure Policy

| Tool | Core Value | Overlap with Stele | Unique Feature Worth Adopting | Gap Stele Could Fill |
|------|-----------|--------------------|-------------------------------|---------------------|
| **OpenPolicyAgent (OPA)** (open-policy-agent/opa) -- 11.7k stars, v1.x, Apache 2.0 | General-purpose policy engine using Rego query language. Unified policy enforcement across Kubernetes, Terraform, API gateways, etc. Web-based test sandbox, IDE plugins. CNCF graduated. **Pricing:** OSS; Styra offers commercial support. | Both use a custom query language for policy definition. Both enforce rules automatically. Both are language/runtime agnostic. | Rego's partial evaluation engine. Policy-as-data decoupling. IDE integration (VS Code plugin with syntax highlighting, linting). Rego's `explain` capability for tracing policy decisions. | OPA is infrastructure-focused. Stele is application-business-logic-focused. OPA lacks code generation; Stele generates pytest. |
| **Conftest** (open-policy-agent/conftest) -- 3.2k stars, v0.64+, MIT | CLI tool for testing structured configuration using Rego. Validates Kubernetes manifests, Terraform, Tekton, JSON, YAML, HCL, TOML, Dockerfiles. `conftest verify` for unit testing Rego rules. | Both validate structured data against rules. Both run in CI. Both use a declarative rule language. | Location-aware output (`_loc` field pinpointing exact issue coordinates). `conftest verify` pattern for self-testing rules. Custom metadata output from rules. | Conftest is configuration-focused, not application-state-focused. No test code generation. |
| **Checkov** (bridgecrewio/checkov) -- 8.7k stars, v2.0, OSS | Cloud misconfiguration detection in IaC. 1000+ built-in rules for Terraform, CloudFormation, Kubernetes, Dockerfiles, Ansible, Bicep. In-memory graph scanning. Secret detection. SARIF/JSON/CSV output. **Pricing:** OSS core; PRISM Cloud (commercial, by Prisma/Checkmarx). | Both run automated checks in CI. Both have a rule-based system. Both detect violations. | 1000+ pre-built rules out of the box. Graph-based cross-resource analysis. Comment-based suppression (`# checkov: skip=CKV_*`). SARIF output for GitHub Security tab. | Checkov is infrastructure-security-focused. Stele is application-business-invariant-focused. Different domains entirely. |
| **CUE** (cue-lang/cue) -- 6.1k stars, v0.12+, Apache 2.0 | Constraint-based data validation language. Defines, generates, and validates JSON, YAML, config, APIs, schemas. CLI tool, Go/JSON/YAML/OpenAPI integration. | Both use a custom language for data validation. Both define constraints declaratively. Both validate structured data. | CUE's constraint solver (backtracking, unification). Schema-to-code generation. Defining data shapes that simultaneously validate AND populate defaults. OpenAPI schema generation from CUE definitions. | CUE is schema/configuration focused. Stele is invariant/behavior focused. CUE has no CI enforcement or locking mechanism. |
| **KCL** (KusionStack/kcl) -- 2.4k stars, v0.12, CNCF Sandbox | Schema-driven configuration language. Static types, strong immutability, constraints. Auto-merge of isolated config blocks. OpenAPI/Kubernetes CRD support. | Both define structured rules declaratively. Both have static type checking. Both support constraints. | Automatic merge mechanism for isolated config blocks. Native OpenAPI/CRD/KRM spec support. Strong immutability guarantees. Multi-language SDK (Go, Python, Java). | KCL is infrastructure/configuration focused. Stele is application-invariant focused. |

**Key Finding:** Policy-as-code tools are the closest conceptual neighbors to Stele. The most transferable ideas are: (1) OPA's `explain` capability for tracing why a policy failed, (2) Checkov's comment-based suppression, (3) CUE's constraint solver for complex validation, (4) Conftest's location-aware output. None of these tools generate application test code, lock protected state, or integrate with AI coding agents.

---

## 3. AI Code Guardrails / Safety

| Tool | Core Value | Overlap with Stele | Unique Feature Worth Adopting | Gap Stele Could Fill |
|------|-----------|--------------------|-------------------------------|---------------------|
| **Guardrails AI** (guardrails-ai/guardrails) -- 6.8k stars, v1.x, MIT | Input/output validators for LLMs. Identifies risks, formats outputs to structured data. Guardrails Hub for pre-built validators. Flask REST API mode. Python/JS. **Pricing:** OSS; commercial Hub access. | Both validate outputs. Both have rule-based validation. Both define validation rules declaratively. | Guardrails Hub (community validators). XML-prompt-based validation. Simulation-based testing with synthetic personas. Runtime controls to catch hallucinations. | Guardrails validates LLM text output. Stele validates application state invariants. Different layers. |
| **Instructor** (jxnl/instructor) -- 12.9k stars, v1.15.x, MIT | Structured outputs for LLMs. Auto-retries on validation failure. Streaming support. Pydantic-based validation. Multi-language (Python, TS, Ruby, Go, Elixir, Rust). Works across OpenAI, Anthropic, Google, Ollama. | Both validate outputs against schemas. Both auto-retry on failure. Both use structured validation. | Automatic retry loop on validation failure with error feedback to LLM. Streaming partial object extraction. Multi-language SDK. | Instructor is LLM-output-focused. Stele is application-state-focused. |
| **NeMo Guardrails** (NVIDIA/NeMo-Guardrails) -- 6.1k stars, v0.21, Apache 2.0 | Programmable guardrails for LLM conversational systems. Five control layers (input, dialog, retrieval, execution, output). Colang custom syntax. LangChain integration. Safety evaluation tools. | Both use custom syntax for defining rules. Both have multi-layer validation. Both run automated checks. | Five-layer control model. Colang conversation flow design. Built-in jailbreak/prompt-injection safeguards. Evaluation tools for hallucination rates. | NeMo is conversation-LLM focused. Stele is application-code focused. |
| **LiteLLM** (BerriAI/litellm) -- 46.1k stars, v1.x, MIT | Python SDK + proxy server for 100+ LLM APIs. Cost tracking, guardrails, virtual keys, traffic routing. 8ms P95 latency. MCP tool integration. | Both have guardrails capability. Both run in proxy/gateway mode. | Unified provider abstraction. Cost monitoring. Virtual key management. Traffic routing. MCP tool integration. | LiteLLM is an LLM gateway/proxy. Stele is an application-level contract tool. |
| **LangSmith** (LangChain) -- 4.9k stars (SDK), commercial SaaS | LLM engineering platform. Debugging, evaluation, monitoring. Tracing, prompt management, datasets, playground. Native LangChain integration. **Pricing:** Freemium SaaS (free tier + paid plans). | Both evaluate outputs. Both have evaluation pipelines. | Evaluation pipelines with judge models. Structured benchmark sets. Interactive playground for rapid config iteration. Full API for custom LLMOps. | LangSmith is LLM-observability focused. Stele is application-invariant focused. |
| **LangFuse** (langfuse/langfuse) -- 26.8k stars, v2.x, OSS | Open-source LLM observability. Tracing, metrics, evals, prompt management, datasets. OpenTelemetry, LangChain, OpenAI SDK, LiteLLM integration. | Both have evaluation/tracing capabilities. | Open-source alternative to LangSmith. OpenTelemetry-native. Self-hosted. Feedback gathering. | Same as LangSmith -- observability layer, not application invariant layer. |

**Key Finding:** AI guardrails tools operate at the LLM I/O layer (prompt -> output). Stele operates at the application state layer (code changes -> invariant checks). They are orthogonal. The most transferable ideas: (1) Instructor's auto-retry loop pattern, (2) Guardrails Hub's community-contributed validators, (3) LangSmith's evaluation pipeline concept.

---

## 4. AI Coding Assistant Guardrails

| Tool | Core Value | Overlap with Stele | Unique Feature Worth Adopting | Gap Stele Could Fill |
|------|-----------|--------------------|-------------------------------|---------------------|
| **Cursor Rules** (.cursorrules) | Per-project AI coding rules and guardrails for Cursor IDE. Defines behavior constraints, coding standards, and file access patterns for the AI assistant. | **HIGHEST OVERLAP.** Both define rules that constrain AI coding behavior. Both live in the project repo. Both are developer-authored guardrails. | Simple file-based configuration (.cursorrules in repo root). No CLI tool needed -- rules are read directly by the IDE. Natural language rule support (not just formal DSL). | Cursor rules are IDE-specific (Cursor only). No test generation, no CI enforcement, no locking mechanism, no agent plugin hooks. Stele is IDE-agnostic and has a Claude Code plugin. |
| **GitHub Copilot Custom Instructions** (.github/copilot-instructions.md) | Project-level custom instructions for GitHub Copilot. Markdown file in repo that guides Copilot's behavior. | Similar concept -- project-level AI coding instructions stored in repo. | Git-native integration (lives in .github/). Markdown format (no custom DSL to learn). | No validation, no test generation, no enforcement. Purely advisory instructions. |
| **Windsurf (Codeium) Guardrails** | Windsurf IDE with Cascade AI assistant. Memories and rules to customize behavior. Workflows to automate trajectories. MCP server integration. | Similar -- defines rules for AI coding behavior within an IDE. | Memory system for persistent context. Workflow automation for repetitive tasks. MCP server integration for extending agent capabilities. | IDE-specific (Windsurf only). No external enforcement, no CI integration. |
| **pre-commit hooks** (pre-commit/pre-commit) -- 40k+ stars, v4.6.0, MIT | Framework for managing multi-language pre-commit hooks. Linters, formatters, refactoring tools. GitHub Actions integration. | Both run automated checks before code changes are committed. Both can fail workflows on violations. | Multi-language hook framework. Huge ecosystem of pre-built hooks (3000+ on GitHub marketplace). `pre-commit autoupdate` for hook version management. Can integrate any CLI tool as a hook. | pre-commit is generic (not contract-aware). No custom DSL, no test generation, no state locking. Stele's CDL is purpose-built for contracts; pre-commit is a generic framework. |

**Key Finding:** This is Stele's most competitive category. Cursor rules are the closest analog to Stele's concept of project-level AI coding guardrails. However, Cursor rules are:
1. IDE-specific (Cursor only, vs. Stele's Claude Code plugin)
2. Advisory only (no enforcement, no test generation)
3. No CI integration (no pipeline blocking)
4. No state locking (no baseline/lock mechanism)

Stele's moat here is the **enforcement** dimension -- Stele actually blocks changes, generates verifiable tests, and integrates in CI pipelines. Cursor rules are purely advisory.

---

## 5. Design-by-Contract / Formal Verification

| Tool | Core Value | Overlap with Stele | Unique Feature Worth Adopting | Gap Stele Could Fill |
|------|-----------|--------------------|-------------------------------|---------------------|
| **Eiffel** (EiffelSoftware) -- 52 stars, commercial | Original design-by-contract language. Pre-conditions, post-conditions, invariants built into the language. Contract-based inheritance, assertion checking. | Both enforce design-by-contract principles. Both have invariants. Both check pre/post conditions. | The formal DbC concepts: pre-conditions, post-conditions, class invariants, feature contracts. These concepts influenced Stele's invariant model. | Eiffel is a programming language, not a tool. Low adoption (52 stars on GitHub). Not practical for existing codebases. |
| **PyContracts** (guacs/pycontracts) -- Python library | Decorator-based contracts for Python functions. Pre-conditions, post-conditions, invariants as decorators. | Both define invariants declaratively. Both run in Python. | Decorator syntax is natural for Python developers. `@contract` pattern is familiar. | Limited adoption. No test generation. No CI integration. No locking. Decorator approach doesn't work for data/state invariants. |
| **TypeGuard** (typeguard package, PyPI) -- Python library | Runtime type checking for Python. `@typechecked` decorator validates arguments, returns, assignments. Import hook for automatic instrumentation. | Both validate at runtime. Both check types. | Import hook for zero-instrumentation type checking. Generator yield/send validation. | Type-only, not contract/invariant-based. No custom DSL. No test generation. |
| **F*** (FStarLang/FStar) -- 3k stars, research | Proof-oriented programming language. Dependent types, SMT solver integration. Multi-language code extraction (OCaml, F#, C, WebAssembly). | Both verify correctness formally. Both have a custom language/syntax. | Mathematical proof guarantees. Extraction to multiple target languages. SMT solver integration. | Academic/research tool. Extremely steep learning curve. Not applicable to existing production codebases. Extraction-only, no runtime enforcement. |
| **LiquidHaskell** (liquidhaskell/lh) -- Haskell refinement types | Refinement types for Haskell. Run-time verified properties via SMT solving. | Both define properties/assertions declaratively. Both verify correctness. | Refinement type syntax embedded in Haskell. SMT-based verification. | Haskell-only. Academic/research. No test generation for production languages. |

**Key Finding:** Design-by-contract and formal verification tools are conceptually adjacent but practically distant. They either require a specific language (Eiffel, F*, LiquidHaskell) or are limited to function-level contracts (PyContracts, TypeGuard). Stele's advantage: it works on existing Python codebases without requiring language changes, generates real tests, and has CI enforcement.

---

## 6. Property-Based / Spec-Driven Testing

| Tool | Core Value | Overlap with Stele | Unique Feature Worth Adopting | Gap Stele Could Fill |
|------|-----------|--------------------|-------------------------------|---------------------|
| **Hypothesis** (HypothesisWorks/hypothesis) -- 8.6k stars, v6.x, MPL-2.0 | Property-based testing for Python. Generates random inputs, shrinks failures to minimal case. 17k+ commits. | Both generate test cases automatically. Both discover edge cases. Schemathesis uses Hypothesis internally. | Failure shrinking (reports simplest failing case). Custom strategy definitions. Stateful testing (StateMachine). | Hypothesis generates input data. Stele generates test code. Different layers. Hypothesis has no contract DSL. |
| **fast-check** (dubzzz/fast-check) -- 4.9k stars, v4.x, MIT | Property-based testing for JavaScript/TypeScript. Strong typing, intelligent shrinking, model-based testing, async race condition detection. | Both generate test cases. Both detect edge cases. | Model-based testing for state machines. Async race condition detection. `fc.pre(...)` precondition filtering. Custom example injection. | JS/TS only. No contract DSL. No CI enforcement or locking. |
| **QuickCheck** (Haskell) | Original property-based testing for Haskell. Defines properties that should hold for all inputs, generates random tests. | Both define properties declaratively. Both generate test cases. | The original property-based testing paradigm. `forAll` quantifier concept. | Haskell-only. No application-state invariants. |

**Key Finding:** Property-based testing tools generate random input data. Stele generates deterministic test code from contract definitions. They are complementary -- Stele could potentially integrate Hypothesis-style random input generation into its scenario execution in the future, but the core approaches are different.

---

## 7. Schema/Validation Frameworks

| Tool | Core Value | Overlap with Stele | Unique Feature Worth Adopting | Gap Stele Could Fill |
|------|-----------|--------------------|----------------------------aine|---------------------|
| **Pydantic** (pydantic/pydantic) -- 27.7k stars, v2.13.x, MIT | Data validation using Python type hints. Fast, extensible. Python + Rust. Pydantic V1 compatibility for incremental upgrades. | Both validate data. Both work with Python. Pydantic AI uses Pydantic for agent validation. | Type-hint-based validation (no custom DSL needed). Pydantic V2 performance (Rust core). Ecosystem (FastAPI integration). | Pydantic validates data at function boundaries. Stele validates application state invariants. Different scope. |
| **Pydantic AI** (pydantic/pydantic-ai) -- 16.9k stars, v0.x, MIT | GenAI agent framework by the Pydantic team. Model-agnostic, fully type-safe. Observability via Logfire/OTel. Human-in-the-loop approval. Durable execution. MCP/A2A support. | **CLOSEST OVERLAP in AI domain.** Both are AI-agent tools. Both validate outputs. Both have type-safety. Both support MCP. | Human-in-the-loop tool approval. Durable execution (preserves progress across failures). Streamed validated outputs. Graph support for complex flows. Pydantic team backing. | Pydantic AI is an agent framework (orchestrates LLM calls). Stele is a contract enforcement tool (validates application state). Different purposes. |
| **Zod** (colinhacks/zod) -- 42.6k stars, v3.x, MIT | TypeScript-first schema validation with static type inference. Zero dependencies, 2kb bundle. Immutable API. Built-in JSON Schema conversion. | Both validate data against schemas. Both have declarative validation rules. | Zero dependencies (2kb gzipped). Immutable API design. TypeScript type inference from schema. JSON Schema conversion. | Zod is a runtime schema validator. Stele is a contract DSL + test generator. Different scope. |
| **JSON Schema** (json-schema-org) -- Industry standard | Cross-language schema specification. Draft 2020-12 latest. OpenAPI schema validation. | Both define validation rules declaratively. Both validate structured data. | Universal standard (cross-language, cross-platform). OpenAPI integration. | JSON Schema is a specification, not a tool. No test generation, no CI enforcement, no locking. |

**Key Finding:** Schema validation tools validate individual data objects at runtime. Stele validates application state invariants across the entire codebase. Pydantic AI is the closest adjacent project -- same ecosystem (Python + Pydantic), AI-agent focused, MCP support. However, Pydantic AI orchestrates agents; Stele constrains them.

---

## White Space Analysis

Areas where no tool currently exists that Stele could dominate:

### 1. AI-Agent-Integrated Contract Enforcement

No tool combines (a) a custom contract DSL, (b) auto-generated test artifacts, (c) protected state locking, AND (d) AI agent guardrails (Claude Code plugin). Stele is the only tool that does all four simultaneously.

**Opportunity:** Position as "the pre-commit hook for AI-generated code." Every AI coding assistant produces code, but none have a verification layer specifically designed for AI-generated changes.

### 2. Application-State Contract Language

Existing contract tools are API-level (Pact), infrastructure-level (OPA), or function-level (PyContracts). There is no tool for declaring and enforcing business invariants at the application state level with a purpose-built DSL.

**Opportunity:** The CDL language fills this gap. As AI generates more application code, the need for verifying that generated code preserves business invariants will grow dramatically.

### 3. Contract-Locking for AI Workflows

Version locking exists for dependencies (lockfiles) and infrastructure (terraform state). There is no "contract lock" concept -- recording the approved state of application invariants and failing when drift occurs. Stele's `stele lock` and `stele baseline-init` are unique.

**Opportunity:** The baseline mechanism for adopting legacy codebases with known drift is a killer feature for enterprise adoption.

### 4. Agent-Aware Rule Maintenance

Stele's agent-facing commands (`stele rules`, `stele agent-context`, `stele why`, `stele propose`) are unique. No other contract tool provides commands specifically designed for AI agents to understand, explain, and maintain rules.

**Opportunity:** This is the differentiator for the AI era. As AI agents become the primary code authors, tools that make contracts agent-understandable become essential.

### 5. Cross-IDE Contract Enforcement

Cursor rules work only in Cursor. Copilot instructions work only in Copilot. Stele's Claude Code plugin provides enforcement in Claude Code, but the underlying contract engine is IDE-agnostic.

**Opportunity:** Build plugins for Cursor, VS Code, and other AI-enabled editors. Stele could become the contract enforcement standard across all AI coding assistants.

---

## Feature Theft List

Specific features from competitors worth adding to Stele, ranked by impact:

### HIGH PRIORITY

1. **OPA Rego `explain` capability** -- When a contract fails, provide an explanation trace showing which sub-expressions were evaluated and how they contributed to the failure. Rego's `explain` is a proven pattern.
   - *Source:* OpenPolicyAgent

2. **Checkov comment-based suppression** -- Allow developers to suppress specific invariant checks with inline comments (e.g., `; stele: ignore=ACCOUNT_IS_ACTIVE`).
   - *Source:* Checkov (`# checkov: skip=CKV_*`)

3. **Instructor auto-retry pattern** -- When a contract check fails during generation, provide a feedback loop that suggests how to fix the underlying code (not the contract).
   - *Source:* Instructor (automatic retry with error feedback)

4. **Guardrails Hub community validators** -- A registry of community-contributed contract patterns (e.g., "financial-invariant-starter-pack", "inventory-consistency-rules").
   - *Source:* Guardrails AI Hub

5. **Conftest location-aware output** -- Pinpoint the exact file coordinate where a contract violation's root cause lies, not just the contract expression.
   - *Source:* Conftest `_loc` field

### MEDIUM PRIORITY

6. **Pydantic AI human-in-the-loop approval** -- Require user confirmation before certain contract changes are applied (e.g., adding high-severity invariants).
   - *Source:* Pydantic AI

7. **pre-commit ecosystem integration** -- Integrate Stele checks as a pre-commit hook. This would make Stele usable by non-Claude-Code workflows.
   - *Source:* pre-commit framework

8. **Hypothesis failure shrinking** -- When a contract invariant fails, try to reduce the failing scenario to the minimal reproduction case.
   - *Source:* Hypothesis

9. **CUE constraint solver** -- For complex invariants that require backtracking or unification, add a constraint solver backend.
   - *Source:* CUE

10. **Zod zero-dependency philosophy** -- Minimize Stele's runtime dependencies. Zod's 2kb bundle is the aspirational target for the generated test code.
    - *Source:* Zod

### LOW PRIORITY (nice to have)

11. **Pact contract promotion workflow** -- Versioned contract promotion (dev -> staging -> prod) for multi-environment deployments.
    - *Source:* Pact Broker

12. **WireMock record-and-replay** -- For scenario-based testing, automatically capture and replay HTTP interactions.
    - *Source:* WireMock

13. **fast-check model-based testing** -- State machine testing for complex stateful workflows.
    - *Source:* fast-check

14. **LangSmith evaluation pipelines** -- Structured benchmark sets for pre-deployment contract verification.
    - *Source:* LangSmith

15. **Vulture dead-code detection** -- Detect contract invariants that never fail (always-pass rules that may be stale).
    - *Source:* Vulture

---

## Moat Analysis

### What Makes Stele Defensible

1. **Custom DSL (CDL)** -- The s-expression based Contract Definition Language is a strong moat. Once teams invest in writing contracts in CDL, switching costs are high. No competitor has a DSL specifically for application business invariants.

2. **Integration Depth** -- Stele integrates at multiple layers simultaneously: CDL definition -> pytest generation -> manifest locking -> Claude Code plugin hooks -> CI pipeline enforcement. Replicating this full stack is non-trivial.

3. **AI Agent Awareness** -- The agent-facing commands (`agent-context`, `why`, `propose`, `maintenance-summary`) are designed specifically for AI agents as first-class consumers. This is forward-looking and will become increasingly valuable as AI coding becomes mainstream.

4. **Baseline Mechanism** -- `baseline-init` for adopting legacy codebases with known drift is a unique feature that solves a real enterprise problem.

5. **Checksum-based Locking** -- SHA-256 based manifest verification with semantic contract hashing provides tamper-evident contract enforcement.

6. **Checker-Backed Rules** -- The `uses-checker` mechanism allows custom Python logic for invariants that can't be expressed in pure CDL, bridging the gap between declarative and imperative.

### What Threatens Stele

1. **Cursor Rules Expansion** -- If Cursor adds test generation, CI enforcement, and state locking to .cursorrules, it would directly compete. Cursor has ~1M+ users and significant funding (Anysphere).

2. **GitHub Copilot Integration** -- GitHub could integrate contract enforcement directly into Copilot/Actions. With GitHub's distribution advantage, this would be hard to compete with.

3. **Pydantic AI Expansion** -- If the Pydantic team extends Pydantic AI into application-state validation (beyond agent orchestration), they have the ecosystem (FastAPI, Pydantic) and user base to compete.

4. **OPA/Rego Adoption** -- OPA could extend Rego into application-level contracts. OPA has CNCF backing, a mature ecosystem, and a proven query language.

5. **pre-commit + LLM Integration** -- If pre-commit hooks gain AI awareness (auto-fixing violations, explaining failures), the generic approach could undercut Stele's specialized approach.

6. **Anthropic Claude Code Platform Lock** -- If Anthropic builds contract enforcement directly into Claude Code as a native feature, Stele's Claude Code plugin advantage disappears. This is both an opportunity (deep integration) and a risk (platform lock).

### Moat Strengthening Recommendations

1. **Expand IDE support** -- Build plugins for Cursor, VS Code, and JetBrains immediately. Don't be Claude Code-only.
2. **Publish the CDL spec** -- Make CDL an open standard. Encourage adoption beyond Stele.
3. **Build a contract registry** -- Like Guardrails Hub, a community registry of contract patterns increases switching costs.
4. **Integrate with pre-commit** -- Make Stele usable as a pre-commit hook. This broadens the TAM and makes Stele the enforcement layer for any AI coding workflow.
5. **Develop a contract migration tool** -- Make it easy to convert PyContracts/typeguard decorators to CDL invariants.
6. **Add an `explain` command** -- Following OPA's pattern, provide detailed failure explanations for debugging.

---

## Summary: Competitive Position Map

```
                    HIGH ENFORCEMENT
                        |
          Stele         |         OPA/Checkov
   (app invariants)     |    (infra policy)
                        |
  AI AGENT GUARDRAILS  +  CI PIPELINE ENFORCEMENT
                        |
          Pact          |        Hypothesis
  (API contracts)       |     (random testing)
                        |
                    LOW ENFORCEMENT
```

Stele sits in the top-right quadrant: **high enforcement** (locks state, blocks CI, blocks agent edits) combined with **AI agent guardrails** (Claude Code plugin, agent-facing commands). No other tool occupies this quadrant. The nearest competitors are:
- **Left of Stele:** Pact, Spring Cloud Contract (enforce but at the API layer, not application state)
- **Below Stele:** OPA, Checkov (enforce but no AI agent integration)
- **Below-Left:** Hypothesis, fast-check (generate tests but no enforcement or AI integration)
