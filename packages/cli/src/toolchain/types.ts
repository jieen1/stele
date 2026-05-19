// Toolchain ingestion types — Phase 3 of DDD + Type-Driven Pattern System.
// These types model the three layers of toolchain validation:
//   1. TypeScript config policy (tsconfig option checks)
//   2. tsc compiler diagnostic ingestion
//   3. ESLint JSON report ingestion

// ---------------------------------------------------------------------------
// Toolchain Violation
// ---------------------------------------------------------------------------

export type ToolchainViolation = {
  ruleId: string;
  ruleKind: "typescript-config-policy" | "typescript-diagnostic" | "eslint";
  file: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  severity: "error" | "warning";
  fix: string;
};

// ---------------------------------------------------------------------------
// TypeScript Config Policy
// ---------------------------------------------------------------------------

export type ToolchainConfigOptions = {
  strict?: boolean;
  exactOptionalPropertyTypes?: boolean;
  noUncheckedIndexedAccess?: boolean;
};

// ---------------------------------------------------------------------------
// tsc Diagnostics
// ---------------------------------------------------------------------------

export type TscDiagnostic = {
  file: string;
  line?: number;
  column?: number;
  code: string;
  message: string;
};

// ---------------------------------------------------------------------------
// ESLint Reports
// ---------------------------------------------------------------------------

export type EslintReport = {
  results: EslintResult[];
};

export type EslintResult = {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
};

export type EslintMessage = {
  ruleId?: string;
  severity: 0 | 1 | 2;
  message: string;
  line?: number;
  column?: number;
};
