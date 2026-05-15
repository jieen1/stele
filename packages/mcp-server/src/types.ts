import type {
  Violation,
  ViolationReport,
} from "@stele/core";

/**
 * Result of a contract check.
 */
export interface CheckResult {
  ok: boolean;
  report: ViolationReport;
  violations: Violation[];
  summary: ViolationReportSummary;
}

/**
 * Summary of a check result (for tools that don't need the full report).
 */
export interface ViolationReportSummary {
  invariantCount: number;
  generatedFileCount: number;
  protectedFileCount: number;
  violationCount: number;
  activeViolationCount?: number;
  suppressedViolationCount?: number;
  outOfScopeViolationCount?: number;
}

/**
 * Response for the validate-edit tool.
 */
export interface ValidateEditResult {
  allowed: boolean;
  reason?: string;
  violations?: Violation[];
  protectedPattern?: string;
}

/**
 * Response for the explain-violation tool.
 */
export interface ExplainResult {
  explanation: string;
  trace?: ExplainTrace[];
  fix?: ViolationFix;
}

/**
 * Single-step failure trace for explainability.
 */
export interface ExplainTrace {
  expression: string;
  evaluated: boolean | null;
  children?: ExplainTrace[];
  explanation?: string;
  failureDetail?: string;
}

/**
 * Violation fix suggestion.
 */
export interface ViolationFix {
  summary: string;
  command?: string;
}

/**
 * MCP tool response.
 */
export interface McpResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Project state for a single MCP server instance.
 *
 * The contract cache is parsed once on first tool call, then reused across
 * all subsequent calls in the same session. This avoids repeated disk IO
 * and parse overhead.
 */
export interface ProjectState {
  projectDir: string;
  configPath: string;
  contractFiles: string[];
  lastLoadTime: number;
  configHash?: string;
}

/**
 * Session summary for status reporting.
 */
export interface SessionSummary {
  totalEdits: number;
  protectedEdits: number;
  blockedEdits: number;
  checks: number;
  violations: number;
  sessionDurationMs: number;
}

/**
 * Tool definition for the MCP server.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<McpResult> | McpResult;
}
