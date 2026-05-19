// ESLint JSON report parser — converts ESLint output to Stele violations.

import type { EslintReport, ToolchainViolation } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse ESLint JSON report and convert profile-required rule violations
 * to ToolchainViolation objects.
 *
 * @param report - ESLint JSON report
 * @param profileRules - Rule IDs that are profile-required (e.g., from design profile)
 */
export function parseEslintReport(report: EslintReport, profileRules: string[]): ToolchainViolation[] {
  const violations: ToolchainViolation[] = [];

  for (const result of report.results) {
    for (const msg of result.messages) {
      // Only convert rules that are explicitly profile-required.
      if (!msg.ruleId) continue;
      if (!profileRules.includes(msg.ruleId)) continue;

      const severity = mapSeverity(msg.severity);

      violations.push({
        ruleId: `typedriven.eslint.${msg.ruleId}`,
        ruleKind: "eslint",
        file: result.filePath,
        line: msg.line,
        column: msg.column,
        code: msg.ruleId,
        message: msg.message,
        severity,
        fix: `Fix ESLint rule "${msg.ruleId}" in ${result.filePath}: ${msg.message}`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapSeverity(severity: 0 | 1 | 2): "error" | "warning" {
  if (severity === 2) return "error";
  return "warning";
}
