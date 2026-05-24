import { contractPath } from "@stele/core";

export const STELE_CONFIG_FILE = "stele.config.json";
export const STELE_BASELINE_FILE = "contract/.baseline.json";

/** Maximum buffer size for child process output capture (16 MB). */
export const MAX_CHILD_PROCESS_BUFFER = 16 * 1024 * 1024;

/** Maximum size before rotating event log files (10 MB). */
export const MAX_EVENT_LOG_SIZE = 10 * 1024 * 1024;

/** Maximum size for single file read (1 MB). */
export const MAX_FILE_READ_SIZE = 1024 * 1024;

/**
 * Languages accepted by the Phase B / architecture / code-shape stages.
 * Mirrors `SupportedLanguage` from `@stele/call-graph-core` — duplicated
 * here so `packages/cli/src/config/**` (the cli-infrastructure DDD
 * module) does not import the call-graph-core context directly, which
 * the generated ddd-context-map architecture forbids.
 */
export type PhaseSupportedLanguage =
  | "typescript"
  | "python"
  | "go"
  | "java"
  | "rust";

/**
 * Per-phase target-language overrides for stages that dispatch on a single
 * language. Phase 0 (self-dogfooding plan) — lets a project keep
 * `targetLanguage = "python"` for Phase A test generation while declaring
 * the Phase B / architecture / code-shape evaluators run against
 * TypeScript source (or vice versa). Kebab-case keys match the CDL
 * mechanism names (`(type-state …)`, `(class-shape …)`).
 */
export interface PhaseLanguages {
  /** Phase B trace-policy evaluator language. Defaults to targetLanguage. */
  trace?: PhaseSupportedLanguage;
  /** Phase B type-state evaluator language. Defaults to targetLanguage. */
  "type-state"?: PhaseSupportedLanguage;
  /** Phase B effect evaluator language. Defaults to targetLanguage. */
  effect?: PhaseSupportedLanguage;
  /** Code-shape default language. Each (boundary)/(class-shape)/... declaration
   *  may still override via its own `(lang …)` field. */
  "code-shape"?: PhaseSupportedLanguage;
  /** Architecture import-extractor language. Defaults to targetLanguage. */
  architecture?: PhaseSupportedLanguage;
}

export type SteleConfig = {
  version: string;
  contractDir: string;
  entry: string;
  generatedDir: string;
  checkerImplDir: string;
  manifestPath: string;
  targetLanguage: string;
  testFramework: string;
  pathMode: string;
  protected: string[];
  phaseLanguages?: PhaseLanguages;
  /** Path to tsconfig.json, relative to project root. Defaults to "tsconfig.json".
   *  Required when any phaseLanguages.* is "typescript" and the default doesn't exist. */
  tsconfig?: string;
  /**
   * Phase 4 self-dogfooding follow-up: when set to `false`, the effect
   * evaluator treats every unresolved call as an advisory NOTICE rather
   * than an error-severity VIOLATION. Default `true` (strict — Round 2
   * D-CG-1). Stele's own repo sets this to `false` because dynamic
   * dispatch via Commander chains + `await import(...)` produces
   * legitimate unresolved calls the call-graph extractor cannot
   * statically model.
   */
  effectStrictMode?: boolean;
};

export const DEFAULT_CONFIG: SteleConfig = {
  version: "0.1",
  contractDir: "contract",
  entry: contractPath("contract/main.stele"),
  generatedDir: "tests/contract",
  checkerImplDir: "contract/checker_impls",
  manifestPath: "contract/.manifest.json",
  targetLanguage: "python",
  testFramework: "pytest",
  pathMode: "auto",
  // Round 4 D-13: this list MUST stay byte-equal (modulo ordering) to
  // `DEFAULT_PROTECTED_PATTERNS` in `@stele/core/src/config/defaults.ts`
  // and `DEFAULT_PROTECTED` in `packages/claude-code-plugin/scripts/
  // pre-tool-protect.js`. The `default-protected-consistent` self-
  // protection checker parses all three on every pytest run and fails
  // loudly on any divergence.
  protected: [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    // Note: kept as a literal (not STELE_BASELINE_FILE) so the
    // default-protected-consistent checker can byte-compare the three
    // independent lists via string-literal extraction.
    "contract/.baseline.json",
    "contract/.manifest.json",
    "contract/design/**/*",
    "contract/design/proposals/**/*",
    "contract/design/approvals/**/*",
    "contract/generated/**/*",
    "tests/contract/**/*",
    "packages/claude-code-plugin/scripts/pre-tool-protect.js",
    "packages/claude-code-plugin/scripts/stop-validate.js",
    "packages/claude-code-plugin/scripts/observation-hook.js",
    "packages/claude-code-plugin/scripts/lifecycle-context.js",
    // Round 13 L-05/P-04: shared bash extractor + shell helpers.
    "packages/claude-code-plugin/scripts/bash-extractors.js",
    "packages/claude-code-plugin/scripts/shell-utils.js",
    "packages/claude-code-plugin/hooks/hooks.json",
    "stele.config.json",
    ".stele/stop-state.json",
    "pnpm-lock.yaml",
    "package.json",
    "packages/*/package.json",
    "packages/*/tsup.config.ts",
    ".github/workflows/**",
    "scripts/publish-npm.mjs",
    "scripts/verify-packed-adoption.mjs",
    // Round 9 P-02: workspace topology + base TS config.
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
  ],
};
