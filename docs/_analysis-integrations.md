# Integration and Language Backend Analysis

> Generated: 2026-05-08
> Purpose: Strategic analysis of language backends and integrations for Stele

---

## 1. Current Architecture Summary

Stele's `LanguageBackend` interface (defined in `@stele/core/src/generator/coordinator.ts`) requires:

- `name`, `framework`, `fileExtension`, `version` metadata
- `generate(contract, config)`: produces `GeneratedFile[]` (path + content)
- Optional `supportFiles(contract, config)`: additional runtime/fixture files

The Python backend (`@stele/backend-python`) demonstrates the pattern:
- **Translator layer**: Maps CDL AST nodes to Python expressions via operator handlers (comparison, arithmetic, collection, logic, temporal, string)
- **Runtime layer**: `_stele_runtime.py` provides helper functions (`stele_call_checker`, `stele_get_path`, `stele_is_modified`, `stele_sum`, etc.)
- **File output**: Generates `__init__.py test files (`test_contract.py`) + `__init__.py`)
- **Output**: `tests/contract/_stele_runtime.py` + `tests/contract/__init__.py` + `tests/contract/test_contract.py`

Each new backend needs the same structure: operator handlers, runtime helpers, and file generation logic.

---

## 2. Language Priority Matrix

### 2.1 TypeScript/JavaScript

| Dimension | Assessment |
|-----------|------------|
| **Market size** | Largest. JavaScript is the #1 most-used language globally (66% in SO 2025 survey). TypeScript dominates new enterprise projects. |
| **AI assistant adoption** | Extremely high. TypeScript is the lingua franca of AI tooling -- Claude Code, Cursor, Windsurf, Copilot all target TS/JS as primary. The Stele CLI itself is written in TypeScript. |
| **Test framework landscape** | **Vitest** is the clear winner for new projects (Jest-compatible API, Vite-powered speed). **Jest** (45.3k GitHub stars) still has the largest installed base but is in maintenance mode. Mocha is legacy. |
| **Implementation difficulty** | **Low**. Stele's core is already TypeScript. The translator layer can share AST types and utilities directly. No cross-language serialization needed. |
| **Strategic value** | **Critical**. A TS backend enables Stele to protect the Stele codebase itself (dogfooding). It also targets the largest developer audience and the AI coding assistant ecosystem where guardrails are most needed. |

**Recommendation: HIGHEST PRIORITY. Build first.**

**Technology stack for TS backend:**
- Test framework: **Vitest** (primary), with Jest compatibility layer
- Assertion library: Vitest's built-in `expect` (Jest-compatible)
- File naming: `test-*vitest` or `*.spec.ts`
- Output dir: `tests/contract/`

### 2.2 Go

| Dimension | Assessment |
|-----------|------------|
| **Market size** | Large and growing. Go is the language of cloud infrastructure, microservices, and Kubernetes. Consistently in the top 10 most-wanted languages. |
| **AI assistant adoption** | High. Go is heavily used in AI infrastructure (LLM serving, vector databases, model pipelines). Claude Code and Cursor support Go well. |
| **Test framework landscape** | **`testing.T` (standard library)** is the default. **testify** (26k GitHub stars) adds assertions and mocks. GoConvey is legacy. No third-party framework has displaced stdlib testing. |
| **Implementation difficulty** | **Medium**. Go's `testing` package is minimal -- assertions require external libraries or manual checks. The `t.Errorf` pattern is simpler than `assert` but less expressive. Need to generate `t.Run` subtests for each invariant. |
| **Strategic value** | **High**. Go microservices are where contract testing is most valuable. API contracts between Go services are a major pain point. The AI infrastructure space (where Go dominates) needs guardrails. |

**Recommendation: HIGH PRIORITY. Build second.**

**Technology stack for Go backend:**
- Test framework: **Standard library `testing`** + **testify** for assertions
- File naming: `*_test.go`
- Output dir: `contract_test/` or `tests/contract/`

### 2.3 Java/Kotlin

| Dimension | Assessment |
|-----------|------------|
| **Market size** | Massive enterprise footprint. Java powers the majority of large enterprises. Kotlin is the Android standard and growing in backend. |
| **AI assistant adoption** | Moderate to high. Java/Kotlin are well-supported by Claude Code, Cursor, and Copilot. Enterprise AI adoption is slower but steady. |
| **Test framework landscape** | **JUnit 5** (7k GitHub stars) is the standard. **AssertJ** provides fluent assertions. **Mockito** for mocking. Spring Boot's contract testing gap is real -- Spring Cloud Contract exists but is heavy and XML/YAML-centric, not CDL-like. |
| **Implementation difficulty** | **Medium-High**. Java's verbosity means more generated code per invariant. Need to handle Maven/Gradle build file conventions. Kotlin is more concise but adds its own syntax. |
| **Strategic value** | **High for enterprise**. Java is where formal contracts matter most (financial services, healthcare, government). The Spring Boot ecosystem has a real gap in lightweight, declarative contract testing. |

**Recommendation: MEDIUM-HIGH PRIORITY. Build third, but target Java first (larger market), Kotlin second.**

**Technology stack for Java backend:**
- Test framework: **JUnit 5** + **AssertJ**
- File naming: `*Test.java`
- Output dir: `src/test/java/.../contract/`

### 2.4 Rust

| Dimension | Assessment |
|-----------|------------|
| **Market size** | Niche but growing rapidly. Most-loved language in SO surveys for 10+ years. Used in performance-critical systems, CLI tools, and increasingly in AI infrastructure. |
| **AI assistant adoption** | Growing. Claude Code supports Rust well. The Rust community values correctness, making guardrails appealing. |
| **Test framework landscape** | **`#[test]`** (standard library). **proptest** for property-based testing (excellent fit for CDL). **expect_test** for snapshot testing. |
| **Implementation difficulty** | **High**. Rust's type system is powerful but adds complexity -- the translator must generate type-correct code. CDL's dynamic nature maps to Rust's `serde_json::Value` or similar. Proptest integration is valuable but non-trivial. |
| **Strategic value** | **Medium**. Rust developers value correctness but already have strong tooling (compile-time checks). CDL would be most useful for property-based testing of business logic, not basic assertions. |

**Recommendation: MEDIUM PRIORITY. Build fourth, but leverage proptest for property-based testing niche.**

**Technology stack for Rust backend:**
- Test framework: **`#[test]`** + **proptest** for property-based
- Assertion: **`assert_eq!`**, **`assert!`** macros
- File naming: `tests/contract_*.rs` or `tests/contract.rs`
- Output dir: `tests/`

### 2.5 C#/.NET

| Dimension | Assessment |
|-----------|------------|
| **Market size** | Large enterprise presence. .NET 8+ is strong in enterprise, gaming, and Azure ecosystems. |
| **AI assistant adoption** | Moderate. Well-supported by Copilot, Claude Code, and Cursor. Enterprise .NET shops are adopting AI tools steadily. |
| **Test framework landscape** | **xUnit.net v3** (4.6k GitHub stars) is the modern standard. **NUnit** is legacy. **FluentAssertions** for fluent assertions. **NSubstitute** for mocking. |
| **Implementation difficulty** | **Medium**. Similar to Java -- verbose but straightforward. .NET's testing infrastructure is mature. |
| **Strategic value** | **Medium**. Enterprise contracts are valuable, but the .NET ecosystem has fewer AI-coding-adjacent workflows compared to TS/Python/Go. |

**Recommendation: MEDIUM PRIORITY. Build fifth, after TS/Go/Java are stable.**

**Technology stack for C# backend:**
- Test framework: **xUnit.net v3**
- Assertion: **FluentAssertions**
- File naming: `*Tests.cs`
- Output dir: `tests/Contract/` or `Tests/Contract/`

### 2.6 Summary Priority Ordering

| Priority | Language | Rationale |
|----------|----------|-----------|
| 1 | **TypeScript/JavaScript** | Largest market, AI lingua franca, same language as Stele core |
| 2 | **Go** | AI infrastructure language, microservice contracts, stdlib testing |
| 3 | **Java** | Enterprise contracts, Spring Boot gap, formal contract needs |
| 4 | **Rust** | Property-based testing niche, correctness-focused community |
| 5 | **C#/.NET** | Enterprise presence, but lower AI-coding adjacency |

---

## 3. Integration Opportunity List

Ranked by impact vs. effort.

### 3.1 GitHub Actions (CI Integration)

| Dimension | Assessment |
|-----------|------------|
| **Impact** | **Extremely High**. GitHub Actions is the most widely used CI platform. Stele as a GitHub Action enables zero-config contract validation on every PR. |
| **Effort** | **Low-Medium**. Generate a composite action that runs `stele verify`. Can leverage existing CLI. |
| **Strategic value** | **Critical**. CI integration is the primary distribution channel for contract testing tools. Pact and Spring Cloud Contract both distribute as CI actions. |

**Recommendation: Build immediately alongside TypeScript backend. This is the highest-ROI integration.**

### 3.2 pre-commit Hooks

| Dimension | Assessment |
|-----------|------------|
| **Impact** | **High**. Catches contract violations before they reach the repository. Complements CI with local developer feedback. |
| **Effort** | **Low**. pre-commit hook that runs `stele verify` locally. Simple Python or shell script wrapper. |
| **Strategic value** | **High**. Developer experience is critical for adoption. pre-commit is the de facto standard for local code quality gates. |

**Recommendation: Build alongside GitHub Actions. Low effort, high impact.**

### 3.3 VS Code Extension

| Dimension | Assessment |
|-----------|------------|
| **Impact** | **High**. Inline contract validation, error squiggles, and quick-fix suggestions. VS Code is the most popular IDE globally. |
| **Effort** | **Medium-High**. Requires Language Server Protocol implementation or extension API. Stele already has a Claude Code plugin; VS Code extension is a parallel effort. |
| **Strategic value** | **High**. IDE integration provides the best developer experience. Real-time feedback on CDL violations. |

**Recommendation: Build after core backends are stable. Consider Language Server Protocol approach to serve both VS Code and other editors.**

### 3.4 GitLab CI

| Dimension | Assessment |
|-----------|------------|
| **Impact** | **Medium-High**. GitLab is the second-most popular CI platform, especially in enterprise and self-hosted scenarios. |
| **Effort** | **Low-Medium**. Similar to GitHub Actions but with different YAML syntax. Can share core verification logic. |
| **Strategic value** | **Medium**. Important for enterprise adoption, but GitHub Actions covers the majority of open-source and SaaS-first teams. |

**Recommendation: Build after GitHub Actions. Low incremental effort, important for enterprise customers.**

### 3.5 JetBrains Plugin

| Dimension | Assessment |
|-----------|------------|
| **Impact** | **Medium**. IntelliJ IDEA, PyCharm, GoLand, and Rider are popular in enterprise Java/Python/Go/.NET development. |
| **Effort** | **High**. JetBrains plugin SDK is complex. Requires Kotlin/Java development. Separate from VS Code extension. |
| **Strategic value** | **Medium**. Enterprise Java/Go shops heavily use JetBrains. A JetBrains plugin would be valuable for the Java and Go backends. |

**Recommendation: Defer until Java and Go backends are stable and have proven demand. Consider a Language Server Protocol approach instead, which would serve JetBrains via the LSP plugin.**

### 3.6 npm/yarn/pnpm Lifecycle Hooks

| Dimension | Assessment |
|-----------|------------|
| **Impact** | **Medium**. Enables `stele verify` in `prepublish`, `precommit`, or custom scripts. Good for JS/TS projects. |
| **Effort** | **Low**. Already works via CLI. Just need to document the pattern. |
| **Strategic value** | **Medium**. Complements CI and pre-commit hooks. Good for monorepos with custom build systems. |

**Recommendation: Document as a pattern, don't build dedicated integration. The CLI already supports this.**

### 3.7 Integration Priority Ordering

| Priority | Integration | Rationale |
|----------|------------|-----------|
| 1 | **GitHub Actions** | Primary distribution channel, highest reach |
| 2 | **pre-commit hooks** | Developer experience, low effort |
| 3 | **VS Code extension** | Best DX, large market |
| 4 | **GitLab CI** | Enterprise coverage |
| 5 | **npm lifecycle hooks** | Documentation-only, CLI already supports |
| 6 | **JetBrains plugin** | Defer, consider LSP approach first |

---

## 4. Technology Stack Recommendations

### 4.1 TypeScript Backend (`@stele/backend-typescript`)

```
packages/backend-typescript/
  src/
    translator.ts          -- Main translator (mirrors backend-python/translator.ts)
    runtime.ts             -- Exports TS runtime source
    runtime/
      stele-runtime.ts     -- TypeScript equivalent of _stele_runtime.py
    templates/
      comparison.ts        -- eq, neq, gt, gte, lt, lte, in, between, approx-eq
      arithmetic.ts        -- add, sub, mul, div, neg, abs
      collection.ts        -- collection, sum, count, avg, min, max, where, forall, exists, etc.
      logic.ts             -- and, or, not, implies, iff, when, if
      temporal.ts          -- temporal operators
      string.ts            -- string operators
    index.ts               -- Public API
```

**Key design decisions:**
- Use **Vitest** as the primary test framework (Jest-compatible API)
- Generate `*.test.ts` files with `describe`/`it` blocks
- Runtime helpers as a TypeScript module (`stele-runtime.ts`)
- Share AST types directly from `@stele/core` (no cross-language serialization)
- Consider generating both Vitest and Jest variants via a config flag

### 4.2 Go Backend (`@stele/backend-go`)

```
packages/backend-go/
  src/
    translator.ts          -- Main translator
    runtime.ts             -- Exports Go test helper source
    runtime/
      stele_helpers.go     -- Go equivalent of runtime helpers
    templates/
      comparison.ts        -- Go comparison operators
      arithmetic.ts        -- Go arithmetic operators
      collection.ts        -- Go collection operators
      logic.ts             -- Go logic operators
      temporal.ts          -- Go temporal operators
      string.ts            -- Go string operators
    index.ts               -- Public API
```

**Key design decisions:**
- Generate `*_test.go` files with `func TestXxx(t *testing.T)` signature
- Use `t.Run` for subtests (one per invariant)
- Use `require.Equal`, `require.True` from testify for assertions
- Go's `map[string]interface{}` for the context (similar to Python dict)
- Generate a `contract_test` package with helper functions

### 4.3 Java Backend (`@stele/backend-java`)

```
packages/backend-java/
  src/
    translator.ts          -- Main translator
    runtime.ts             -- Exports Java test helper source
    runtime/
      SteleRuntime.java    -- Java equivalent of runtime helpers
    templates/
      comparison.ts
      arithmetic.ts
      collection.ts
      logic.ts
      temporal.ts
      string.ts
    index.ts               -- Public API
```

**Key design decisions:**
- Generate `*Test.java` files with `@Test` annotations
- Use AssertJ for fluent assertions (`assertThat(...).isEqualTo(...)`)
- Generate `@BeforeEach` for context setup
- Support both Maven and Gradle via generated `pom.xml`/`build.gradle` snippets
- Java's `Map<String, Object>` for context

### 4.4 Shared Patterns

All backends should share:
- **AST types** from `@stele/core` (already done)
- **LanguageBackend interface** implementation (already defined)
- **Error codes** in the E06xx range (backend errors)
- **File structure**: translator + runtime + templates + index
- **Operator handler pattern**: `Record<string, Handler>` mapping CDL operator names to language-specific generators

---

## 5. Go-to-Market Analysis

### 5.1 Fastest Path to Adoption: TypeScript + GitHub Actions + pre-commit

**Why this combination:**

1. **TypeScript backend** targets the largest audience (66% of developers use JS, TypeScript is the fastest-growing enterprise language)
2. **GitHub Actions** provides zero-friction onboarding -- one workflow file adds contract validation to every PR
3. **pre-commit hooks** provide immediate local feedback, creating habit formation

**Target users:**
- Teams already using Claude Code or Cursor (the primary AI coding assistants)
- TypeScript/JavaScript projects with existing Vitest or Jest setup
- Open-source projects that want to add contract testing to CI

**Adoption path:**
```
1. Developer installs Stele CLI (npm install -g @stele/cli)
2. Developer writes CDL rules in .stele/ directory
3. Stele generates Vitest test files (stele generate)
4. Developer adds GitHub Action workflow
5. Developer adds pre-commit hook
6. Every PR now validates contracts automatically
```

### 5.2 Second Wave: Go + GitLab CI

**Why this combination:**

1. **Go backend** targets the AI infrastructure and microservices market
2. **GitLab CI** is popular in enterprise and self-hosted environments (where Go is often deployed)
3. Go's stdlib testing means minimal dependencies

**Target users:**
- Kubernetes-native teams
- AI infrastructure teams (LLM serving, vector databases)
- Microservice architectures with Go APIs

### 5.3 Enterprise Wave: Java + JetBrains + GitLab CI

**Why this combination:**

1. **Java backend** targets the enterprise contract market
2. **JetBrains plugin** provides IDE integration for IntelliJ/PyCharm users
3. **GitLab CI** covers enterprise CI/CD pipelines

**Target users:**
- Financial services, healthcare, government
- Spring Boot microservice teams
- Teams with formal compliance requirements

### 5.4 Niche Wave: Rust + pre-commit + GitHub Actions

**Why this combination:**

1. **Rust backend** with proptest integration targets the property-based testing niche
2. **pre-commit hooks** are popular in the Rust community (cargo-expand, clippy, etc.)
3. **GitHub Actions** covers the open-source Rust ecosystem

**Target users:**
- Rust projects with complex business logic
- Teams wanting property-based testing of CDL rules
- Systems programming with contractual guarantees

---

## 6. Risk Assessment

### 6.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| TS backend diverges from Python backend behavior | Medium | High | Share test fixtures across backends, cross-verify output |
| Go's minimal assertions limit CDL expressiveness | Low | Medium | Use testify for rich assertions, document limitations |
| Rust type inference conflicts with CDL dynamic types | Medium | Medium | Use `serde_json::Value` as the universal context type |
| Java verbosity bloats generated code | High | Low | Accept it as a tradeoff; Java developers expect verbosity |

### 6.2 Market Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AI coding assistants build native contract testing | Medium | High | Focus on the CDL abstraction layer as the differentiator |
| Existing contract testing tools add AI features | High | Medium | Stele's advantage is AI-native design, not AI as an add-on |
| Developer fatigue from too many tools | High | Medium | Emphasize zero-config setup and IDE integration |

---

## 7. Recommended Build Order

| Phase | Deliverables | Timeline Estimate |
|-------|-------------|-------------------|
| **Phase 1** | TypeScript backend + GitHub Actions + pre-commit | 4-6 weeks |
| **Phase 2** | Go backend + GitLab CI | 4-6 weeks |
| **Phase 3** | Java backend + JetBrains plugin (or LSP) | 6-8 weeks |
| **Phase 4** | Rust backend (proptest) + C# backend | 6-8 weeks |
| **Phase 5** | VS Code extension (LSP-based) | 8-12 weeks |

---

## 8. Key Findings Summary

1. **TypeScript is the obvious first backend** -- largest market, same language as Stele core, highest AI assistant adoption
2. **GitHub Actions is the critical integration** -- primary distribution channel for any contract testing tool
3. **Go is the strategic second language** -- AI infrastructure language, microservice contracts, stdlib testing simplicity
4. **Vitest over Jest for TS backend** -- Vitest is the modern choice, Jest is in maintenance mode
5. **testify for Go backend** -- 26k stars, well-maintained, complements stdlib testing
6. **JUnit 5 + AssertJ for Java backend** -- industry standard, fluent assertions match CDL expressiveness
7. **pre-commit hooks are low-effort, high-impact** -- should be built in Phase 1 alongside GitHub Actions
8. **Language Server Protocol is the smart IDE strategy** -- one LSP server serves VS Code, JetBrains, and other editors, avoiding separate plugin development
9. **The CDL abstraction is the moat** -- AI assistants will generate tests, but CDL provides a declarative, version-controllable contract language that AI can't replace
