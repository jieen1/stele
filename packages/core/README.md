# @stele/core

Core library for the Stele contract framework. Provides CDL parsing, validation, normalization, manifest management, baseline handling, and generator coordination — the language- and tool-agnostic engine that the CLI and language backends build on.

## Install

```bash
npm install @stele/core
```

## What it exports

- **Parsing** — `lex()`, `parseFile()` plus the `Token` and `ParsedFile` types.
- **Loading** — `loadContract()`, `validateContract()` with recursive import resolution and cycle detection.
- **Normalization** — `normalizeContract()` for stable hashing and review output.
- **Registries** — `createCoreOperatorRegistry()`, `createOperatorRegistry()` and the `OperatorSpec` types.
- **Manifests** — `writeManifest()`, `verifyManifest()` for SHA-256 protected-file locking; the `ContractManifest` and `VerificationResult` types.
- **Baselines** — `createViolationBaseline()`, `filterViolationReport()`, `readViolationBaseline()`, `writeViolationBaseline()`.
- **Generation** — `coordinateGeneration()`, `verifyGenerated()` and the `LanguageBackend`, `GenerationConfig`, `GeneratedFile` types.
- **Reports** — `createViolation()`, `createViolationReport()`, `buildViolationFingerprint()`, `formatViolationReportHuman()`, `formatViolationReportJson()`.
- **Errors** — the `SteleError` type used uniformly across all core modules.

The full AST, error, operator, and report type surfaces are exported from `@stele/core` — see `src/index.ts` for the canonical list.

## Determinism contract

`@stele/core` is a pure library. The same input must produce the same output. Generated source is byte-stable; the manifest layer hashes it. Anything in this package that introduces nondeterminism (clock, random, env, filesystem ordering) is a defect.

## Where it sits

`@stele/core` is consumed by `@stele/cli` and language backends like `@stele/backend-python`. End users do not depend on it directly — they install the CLI.

For the architecture overview see [`docs/architecture.md`](../../docs/architecture.md). For the CDL spec see [`docs/spec/cdl.md`](../../docs/spec/cdl.md).
