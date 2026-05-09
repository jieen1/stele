# Stele Documentation

Welcome. This is the index for everything outside the [project README](../README.md).

## For users

| Doc | What you get |
| --- | --- |
| [guides/python-integration.md](guides/python-integration.md) | Adopt Stele in an existing Python + pytest application. The full workflow: install, scaffold, wire `stele_context`, generate, lock, check, custom checkers, temporal helpers, CI. |
| [guides/claude-code-plugin.md](guides/claude-code-plugin.md) | Install and use the Claude Code plugin. Hook lifecycle, slash commands, protected paths, the controlled contract-change flow. |
| [spec/cdl.md](spec/cdl.md) | Complete reference for CDL: grammar, top-level forms, invariant fields, scenario syntax, all 51 operators, error codes (E0001–E0606), exit codes. The narrow spec, grounded in the shipped implementation. |
| [spec/cli-output.md](spec/cli-output.md) | JSON output schemas for CLI commands (`stele check --json`, `stele why --json`, `stele impact --json`). Used by CI integrations, VS Code extension, agent-hooks SDK. |

## Phase plans (refined v2.0)

These are the implementation slices the project has committed to delivering. The strategy/roadmap document is upstream; these are the contracts.

| Doc | What you get |
| --- | --- |
| [prd-phase-0.md](prd-phase-0.md) | Phase 0 prerequisites (~2 weeks): npm publish, test debt sprint, backend registry refactor, conformance test suite. |
| [prd-phase-1.md](prd-phase-1.md) | Phase 1 (~11-13 weeks, 2 FTE): TypeScript backend, GitHub Action + PR comment, pre-commit, operators batch 1, incremental generation, Code Shape, `stele why` witness, `--recursive` flag, agent-hooks SDK + Cursor. |
| [prd-phase-2.md](prd-phase-2.md) | Phase 2 (~8-10 weeks, 2 FTE): Go backend, VS Code extension MVP, `stele impact`, operators batch 2. |
| [internal/prd-round-1-review.md](internal/prd-round-1-review.md) | Round 1 audit synthesis: 4 independent reviewers, the cuts (EP08 self-healing, EP11 plugins, EP10 dashboard, EP12 Rust), the missing features (`stele why` enrichment, monorepo, PR comment, Cursor). |
| [internal/prd-round-2-review.md](internal/prd-round-2-review.md) | Round 2 audit synthesis: 3 independent reviewers, the further cuts (EP07 trace file, EP08 workspace.json, EP12 JSON report), promoted EP14 to Phase 1, factual error fixes. |

## For contributors

| Doc | What you get |
| --- | --- |
| [architecture.md](architecture.md) | Concise tour of the four layers (backends → core → CLI → IDE plugin), data flow, and where to extend. |
| [contributing/development.md](contributing/development.md) | Local setup, build/test commands, source conventions, common workflows. |
| [contributing/testing.md](contributing/testing.md) | Test strategy, what each suite covers, how to run packed-adoption verification. |
| [contributing/release.md](contributing/release.md) | npm publishing flow: trusted publishing, dry-run, verification. |

## Original design blueprint

| Doc | Notes |
| --- | --- |
| [design/项目设计文档.md](design/项目设计文档.md) | The original Chinese design document (v0.1, dated 2026-05-04). Authoritative for *intent and philosophy* — three-layer protection, the "为 AI 而设计的语言" principle, the boundary triangle. Some sections are aspirational where shipped code has diverged; the [spec](spec/cdl.md) and the [architecture overview](architecture.md) reflect what's actually built. |

## Strategy & roadmap

| Doc | Notes |
| --- | --- |
| [strategy/roadmap.md](strategy/roadmap.md) | Phased extension plan (Chinese): P0 immediate, P1 near-term, P2 medium-term, P3 long-term, with risk mitigation. |
| [strategy/competitive-analysis.md](strategy/competitive-analysis.md) | Positioning across 28+ tools in 7 categories (contract testing, policy-as-code, AI guardrails, AI coding tools, design-by-contract, property testing, schema validation). White-space analysis and feature-theft list. |
| [strategy/extension-opportunities.md](strategy/extension-opportunities.md) | Language-backend priority matrix, integration ranking, market data, go-to-market sequencing. |
| [strategy/integration-analysis.md](strategy/integration-analysis.md) | Technical analysis of TS/Go/Java/Rust/C# backends and CI/IDE integration paths, with risk assessment and recommended build order. |

## Internal audit snapshots

These are historical snapshots dated 2026-05-08. Use them for context, not as live invariants — implementation moves on.

| Doc | Notes |
| --- | --- |
| [internal/codebase-analysis.md](internal/codebase-analysis.md) | Architectural audit of the as-shipped code: package inventory, capabilities, gaps vs. mature tools, extension points, scorecard. |
| [internal/test-coverage-gap-report.md](internal/test-coverage-gap-report.md) | File-by-file coverage map with prioritized remediation plan. Identifies the highest-leverage tests to add. |

## Historical implementation plans

`superpowers/plans/` contains the planning documents that were written ahead of v0.1 implementation. They are kept for traceability and are no longer maintained.
