import type { ViolationReport } from "@stele/core";

/**
 * Backend pair selector parsed from STELE_CONFORMANCE_BACKENDS env.
 *
 * Format: `<language>:<framework>` (e.g. "python:pytest", "typescript:vitest").
 */
export type BackendSpec = {
  language: string;
  framework: string;
};

/**
 * One conformance fixture loaded from `tests/conformance/fixtures/<id>/`.
 *
 * Phase 0 only ships Python fixtures; later EPs (TypeScript, Go) reuse the
 * same record by setting different BACKENDS via env.
 */
export type Fixture = {
  /** Folder name, e.g. "01-simple-invariant"; used to scope tmpdir / test labels. */
  id: string;
  /** Absolute path to the fixture directory. */
  dir: string;
  /** Parsed `app-state.json`. Runner forwards it via `LanguageBackend.writeFixtureBootstrap`. */
  appState: unknown;
  /** Parsed `expected-violations.json`. */
  expectedViolations: ViolationReport;
  /** Parsed `stele.config.json` (without `targetLanguage` / `testFramework`). */
  baseConfig: Record<string, unknown>;
  /** Whether this fixture exercises features only Python supports today (e.g. EP06 code-shape). */
  requiresCodeShape?: boolean;
  /**
   * Round 3 P0-9: Phase B mechanisms (trace / type-state / effect) currently
   * only have a TypeScript backend. When this flag is true the conformance
   * runner skips the fixture on non-TS backends with a clear reason.
   */
  requiresPhaseB?: boolean;
};

/**
 * Result of running a fixture × backend pair.
 *
 * v0.2 only fills `report` (drift report from `stele check --json`) plus
 * coarse `runnerExitCode`/`runnerSkipped` flags. EP07 will merge per-invariant
 * pytest pass/fail into the report.
 */
export type FixtureRunResult = {
  /** Combined ViolationReport (drift + future invariant failures). */
  report: ViolationReport;
  /** Test-runner exit code; null when skipped. */
  runnerExitCode: number | null;
  /** True when test runner was unavailable (e.g. pytest not installed). */
  runnerSkipped: boolean;
  /** Reason text shown in skip messages (when runnerSkipped is true). */
  runnerSkipReason?: string;
};
