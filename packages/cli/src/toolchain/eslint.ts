// ESLint JSON report parser — converts ESLint output to Stele violations.

import type { EslintReport, EslintResult, ToolchainViolation } from "./types.js";

// ---------------------------------------------------------------------------
// Rule alias expansion
// ---------------------------------------------------------------------------

/**
 * Common ESLint core rules that have TypeScript equivalents from
 * @typescript-eslint/eslint-plugin. When a profile specifies the core rule
 * (e.g., "no-unused-vars"), we should also match the scoped version
 * (e.g., "@typescript-eslint/no-unused-vars").
 */
const RULE_ALIAS_MAP: Map<string, string[]> = new Map([
  ["no-unused-vars", ["@typescript-eslint/no-unused-vars"]],
  ["no-console", ["@typescript-eslint/no-console"]],
  ["no-shadow", ["@typescript-eslint/no-shadow"]],
  ["no-use-before-define", ["@typescript-eslint/no-use-before-define"]],
  ["default-param-last", ["@typescript-eslint/default-param-last"]],
  ["no-inferrable-types", ["@typescript-eslint/no-inferrable-types"]],
  ["no-explicit-any", ["@typescript-eslint/no-explicit-any"]],
]);

/**
 * Expand a list of profile rule IDs to include known TypeScript aliases.
 * E.g., ["no-unused-vars"] → ["no-unused-vars", "@typescript-eslint/no-unused-vars"]
 */
function expandProfileRules(profileRules: string[]): string[] {
  const expanded = new Set<string>(profileRules);
  for (const rule of profileRules) {
    const aliases = RULE_ALIAS_MAP.get(rule);
    if (aliases) {
      for (const alias of aliases) {
        expanded.add(alias);
      }
    }
  }
  return [...expanded];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse ESLint JSON report and convert profile-required rule violations
 * to ToolchainViolation objects.
 *
 * @param report - ESLint JSON report (may be array from flat config, or { results: ... } from legacy config)
 * @param profileRules - Rule IDs that are profile-required (e.g., from design profile)
 */
export function parseEslintReport(report: EslintReport | EslintResult[], profileRules: string[]): ToolchainViolation[] {
  const violations: ToolchainViolation[] = [];
  const expandedRules = expandProfileRules(profileRules);
  const results = Array.isArray(report) ? report : (report.results ?? []);

  for (const result of results) {
    for (const msg of result.messages) {
      // Only convert rules that are explicitly profile-required.
      if (!msg.ruleId) continue;
      if (!expandedRules.includes(msg.ruleId)) continue;

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
