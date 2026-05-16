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
 * Convert core's ViolationReportSummary (snake_case) to our camelCase version.
 */
export function toReportSummary(summary: import("@stele/core").ViolationReportSummary): ViolationReportSummary {
  return {
    invariantCount: summary.invariant_count ?? 0,
    generatedFileCount: summary.generated_file_count ?? 0,
    protectedFileCount: summary.protected_file_count ?? 0,
    violationCount: summary.violation_count ?? 0,
    activeViolationCount: summary.active_violation_count,
    suppressedViolationCount: summary.suppressed_violation_count,
    outOfScopeViolationCount: summary.out_of_scope_violation_count,
  };
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
