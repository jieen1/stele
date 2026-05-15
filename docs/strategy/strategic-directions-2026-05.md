# Stele Strategic Directions — 2026-05-15

> Synthesized from 5 independent research agents across 5 frontier directions.
> Research date: 2026-05-15. Landscape is fast-moving; validate before committing.

---

## Executive Summary

Stele occupies unique territory: **application-level invariants enforced through AI agent constraints**. No competitor spans the full stack — contract DSL, auto-generated tests, protected-state locking, AND editor-level enforcement.

The research identifies 3 high-leverage expansion directions, ranked by immediate impact:

| Priority | Direction | Effort | Impact |
|----------|-----------|--------|--------|
| **P0** | MCP Server (portability beyond Claude Code) | 2-3 weeks | Unlock Cursor, Windsurf, Copilot |
| **P0** | pre-commit + GitHub Actions integration | 1-2 weeks | Zero-config distribution channel |
| **P1** | OPA-style `explain` for invariant failures | 3-4 weeks | Single biggest UX improvement |

---

## 1. Competitive Landscape: White Space Analysis

### Position Map

```
                     HIGH ENFORCEMENT
                         |
           Stele         |         OPA / Checkov
    (app invariants)   |    (infra policy)
        + Claude Code   |
          plugin        |
    Agent Guardrails   |
    Template (MCP)      |
                         |
  AI AGENT GUARDRAILS +  CI PIPELINE ENFORCEMENT
                         |
     Guardrails AI      |    Pact
   (LLM output)         |  (API contracts)
         Instructor    |
   (structured output)  |
                         |
                     LOW ENFORCEMENT
```

### What Stele Gets Right That Others Miss

| Capability | Stele | Nearest Competitor | Gap |
|------------|-------|-------------------|-----|
| Custom contract DSL (CDL) | Yes | Guardrails AI (RAIL XML) | CDL more expressive for business invariants |
| Auto-generated tests | Yes (5 languages) | Schemathesis (from OpenAPI) | Stele generates from contracts, not schemas |
| Protected-state locking | Yes (SHA-256 manifest) | None | **Unique capability** |
| Editor hook enforcement | Yes (Claude Code plugin) | Agent Guardrails Template (MCP) | Stele has contract awareness; AGT is rule-based |
| Agent-facing commands | Yes | None | Unique to Stele |
| Multi-language backends | 5 languages | Pydantic AI (Python only) | Language-agnostic at contract layer |

### Key Risks

1. **Anthropic Claude Code platform lock** — If Anthropic builds contract enforcement into Claude Code, Stele's plugin advantage evaporates. **Mitigation: MCP + Cursor/Windsurf expansion.**
2. **Agent Guardrails Template maturation** — MCP-based architecture is more portable than Claude Code hooks. If they add contract DSL, they directly compete.
3. **Pydantic AI expansion** — 16.9k stars, growing fast. If they extend into application-state validation, ecosystem advantage is significant.
4. **GitHub-native enforcement** — GitHub building invariant checking into Copilot or Actions would be hard to compete against.

---

## 2. Frontier Direction 1: MCP as Distribution Channel

### Context

The Model Context Protocol (25k+ stars) has become the de-facto standard for AI assistant interoperability. Stele's Claude Code plugin is powerful but locked to one platform.

### What the Research Found

- **Agent Guardrails Template** uses MCP for session-based enforcement (file edit validation, bash validation, git operations). This is the closest architecture to what Stele should build.
- **MCP server architecture** would make Stele discoverable by Cursor, Windsurf, VS Code Copilot, and any MCP-compatible assistant.
- Current Claude Code plugin uses script-based hooks (`pre-tool-protect.js`, `stop-validate.js`). These would translate to MCP tools: `stele_validate_edit`, `stele_check_session`, `stele_explain_violation`.

### Proposed Work

```
packages/mcp-server/
  index.ts                # MCP server entry point
  tools/
    validate-edit.ts      # Validates proposed edits against contracts
    check-session.ts      # Session-ending invariant check
    explain-violation.ts  # Explain why a violation occurred
    list-contracts.ts     # List active contracts for context injection
    propose-contract.ts   # Agent proposes new contract (append-only)
```

### Impact

- **Platform independence**: Same contract engine, any AI assistant
- **Distribution**: MCP marketplace, Cursor marketplace, VS Code extension
- **Competitive moat**: Agent Guardrails Template has MCP but no contract DSL. Stele has CDL + MCP = full stack.

### Estimated Effort

2-3 weeks. Core engine is pure and deterministic. Main work: MCP server scaffolding, tool translations, connection to existing `@stele/core` pipeline.

---

## 3. Frontier Direction 2: CI/CD Quality Gates

### Context

No "AI-aware CI" category exists. The closest are generic CI tools (GitHub Actions), policy engines (OPA, Conftest), and security scanners (Checkov).

### What the Research Found

- **pre-commit** (40k+ stars) is the distribution channel. A `stele` pre-commit hook runs `stele check` on every commit. Zero-config for adopters who install the package.
- **GitHub Actions**: `.github/workflows/stele.yml` template for PR checks. Exit codes already defined: 0 (clean), 2 (drift), 3 (tamper).
- **SARIF output** (Checkov pattern): Violation reports in SARIF format → GitHub Security tab integration.
- **OpenSSF Scorecard** (3.6k stars): Stele's contract verification is a form of automated security scoring. A `stele score` command could contribute to Scorecard.

### Proposed Work

```
packages/github-action/  # Already exists, extend
  action.yml
  src/main.ts

packages/pre-commit/  # New
  .pre-commit-hooks.yaml
  stele-check.sh

templates/ci/  # New
  github-actions.yml
  gitlab-ci.yml
```

### Impact

- **Distribution**: pre-commit hooks discover Stele organically
- **CI integration**: PR-level contract verification without local install
- **Supply-chain**: SLSA v1.0 provenance via SHA-256 manifest

### Estimated Effort

1-2 weeks for pre-commit + GitHub Actions. SARIF output: additional 1-2 weeks.

---

## 4. Frontier Direction 3: Violation Explainability

### Context

When an invariant fails, users need to understand WHY. The OPA/Rego `explain` capability is the gold standard — it traces which sub-expressions were evaluated and how they contributed.

### What the Research Found

- **OPA/Conftest**: Location-aware output (`_loc` field) pins violations to exact coordinates.
- **Checkov**: Inline comment suppression (`# checkov: skip=CKV_*`).
- **Hypothesis**: Failure shrinking — reduces failing scenario to minimal reproduction case.
- **fast-check**: Model-based testing for stateful workflows.

### Proposed Work

```
packages/core/src/evaluator/
  explain.ts   # Trace-based violation explanation
  shrink.ts   # Minimal reproduction reduction

CDL operator additions:
  (explain (path x y))        # Attach explanation context
  (suppress INVARIANT_ID "reason")  # Inline suppression
```

### Impact

- **UX**: Single biggest improvement for adoption. Users need to understand WHY something failed.
- **Developer experience**: Follows Checkov's `explain` + `skip` pattern, proven in production.

### Estimated Effort

3-4 weeks. Requires evaluator changes + CDL operator additions + suppression registry.

---

## 5. Frontier Direction 4: Multi-Agent Safety

### Context

Multi-agent frameworks (LangGraph, AutoGen, CrewAI) have no contract enforcement. Safety is advisory (prompt-level). No framework guarantees "agent A must not modify files agent B protects."

### What the Research Found

- **LangGraph** (14k stars): Safety is implicit in graph topology. No formal contracts.
- **AutoGen** (42k stars): Human-in-the-loop approval. Advisory, not enforced.
- **CrewAI** (26k stars): Role-based delegation. No inter-agent contracts.
- **CRDTs** (Yjs 9.4k stars): No agent framework uses CRDTs for shared state. Conflict resolution is LLM-driven, not contract-driven.

### Proposed Work

```
CDL additions for multi-agent:
  (agent "name")                          # Agent identity
  (scope AGENT_NAME (path x y))          # Scope: agent X owns path Y
  (conflict (path x y) RESOLUTION_FN)    # Conflict resolution
```

### Impact

- **New market**: Multi-agent safety is a growing category. No tool fills it.
- **Integration**: Stele as guard plugin for LangGraph, AutoGen, CrewAI.
- **Long-term**: Agent-to-agent CDL protocol for cross-agent contracts.

### Estimated Effort

6-8 weeks. Requires new CDL operators, scope engine, conflict resolution.

---

## 6. Frontier Direction 5: Formal Verification Bridge

### Context

The long-term vision: translate CDL invariants to formal specs (Dafny, F*, Coq) for theorem proving. Currently academic; the bridge is research-level.

### What the Research Found

- **F*** (3k stars): Proof-oriented programming. Too steep for production, but the multi-language extraction is relevant.
- **Dafny** (1.2k stars): Verifying language with separation logic. Could be a Stele target.
- **LiquidHaskell** (1.8k stars): Refinement types for Haskell.

### Proposed Work

Phase 1 (research): CDL → Dafny translation proof of concept.
Phase 2: CDL → CUE constraint solver for complex invariants.
Phase 3: Formal verification pipeline for critical contracts.

### Impact

Long-term credibility. Positions Stele at the intersection of contracts + formal methods. Not a near-term deliverable.

### Estimated Effort

Research sprint: 2-4 weeks PoC. Full pipeline: 6+ months.

---

## 7. What to Learn from Competitors

### HIGH PRIORITY (immediate)

1. **Agent Guardrails Template MCP integration** — Port plugin architecture to MCP server
2. **Instructor auto-retry feedback loop** — Guide agent to fix code, not contracts
3. **Guardrails AI Hub (community validators)** — Registry of contract pattern starters
4. **Checkov inline suppression** — `; stele: ignore=INVARIANT_ID` pattern
5. **pre-commit integration** — Zero-config distribution channel

### MEDIUM PRIORITY (strategic)

6. **OPA-style `explain` capability** — Trace-based violation explanation
7. **Hypothesis failure shrinking** — Minimal reproduction reduction
8. **fast-check model-based testing** — State machine testing for workflows
9. **SARIF output** — GitHub Security tab integration
10. **OpenSSF Scorecard contribution** — Contract verification as security score

---

## 8. Recommended Roadmap (Next 90 Days)

### Month 1: Distribution + Platform

- [ ] MCP Server (packages/mcp-server/) — 2 weeks
- [ ] pre-commit hook — 1 week
- [ ] GitHub Action enhancement — 1 week
- [ ] TypeScript backend stabilization — ongoing

### Month 2: UX + Explainability

- [ ] OPA-style `explain` for violations — 2 weeks
- [ ] Inline suppression (`; stele: ignore=`) — 1 week
- [ ] SARIF output for GitHub Security — 1 week

### Month 3: Multi-Agent + Community

- [ ] Agent Guardrails Template compatibility layer — 2 weeks
- [ ] Community contract pattern registry — 2 weeks
- [ ] Contract Hub MVP — ongoing

---

## 9. Summary

| Direction | Priority | Time to First Impact | Risk |
|-----------|----------|---------------------|------|
| MCP Server | P0 | 2-3 weeks | Low — architecture is proven |
| CI Integration | P0 | 1-2 weeks | Low — infrastructure exists |
| Explainability | P1 | 3-4 weeks | Medium — evaluator changes |
| Multi-Agent Safety | P1 | 6-8 weeks | High — new category, unproven demand |
| Formal Verification | P2 | 6+ months | High — research-level |

**Bottom line**: Stele has a unique product-market fit in the AI agent safety space. The white space around application-level invariants is unclaimed. The fastest path to impact: MCP server + pre-commit integration. That unlocks distribution, platform independence, and organic growth through the AI coding tool ecosystem.

---

*Sources: 5 independent research agents. Key repos: Guardrails AI (6.8k), Instructor (12.9k), Pydantic AI (16.9k), Agent Guardrails Template, OPA (11.7k), pre-commit (40k+), Hypothesis (8.6k), Checkov (8.7k), LangGraph (14k), AutoGen (42k), CrewAI (26k), OpenSSF Scorecard (3.6k).*
