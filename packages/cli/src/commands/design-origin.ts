// Design-origin metadata — resolves generation manifest entries for a given rule.
// Shared by `explain` and `why` commands so both can trace violations back
// to the design profile section that generated them.

import { readManifest, type GeneratedRuleEntry } from "../design-generator/manifest.js";

export type EnforcementLevel = "hard" | "partial" | "advisory";

export type DesignOriginInfo = {
  profileSection: string;
  origin: string;
  enforcementLevel: EnforcementLevel;
  ruleKind: string;
};

/**
 * Attempt to resolve design-origin metadata for the given rule ID.
 *
 * Strategy:
 *   1. Look up the rule in the generation manifest by full rule ID.
 *   2. If not found, try prefix matching.
 *   3. Fall back to null if no manifest or no match.
 */
export function resolveDesignOrigin(
  projectDir: string,
  ruleId: string,
): DesignOriginInfo | null {
  const manifest = readManifest(projectDir);
  if (!manifest) return null;

  const entry = findManifestEntry(manifest.generatedRules, ruleId);
  if (!entry) return null;

  return {
    profileSection: entry.origin,
    origin: entry.origin,
    enforcementLevel: inferEnforcementLevel(entry),
    ruleKind: entry.ruleKind,
  };
}

function findManifestEntry(
  entries: GeneratedRuleEntry[],
  ruleId: string,
): GeneratedRuleEntry | null {
  const exact = entries.find((r) => r.ruleId === ruleId);
  if (exact) return exact;

  const prefix = entries.find((r) => r.ruleId.startsWith(ruleId + "."));
  if (prefix) return prefix;

  const reversePrefix = entries.find((r) => ruleId.startsWith(r.ruleId + "."));
  if (reversePrefix) return reversePrefix;

  return null;
}

function inferEnforcementLevel(entry: GeneratedRuleEntry): EnforcementLevel {
  // Core-nodes are complexity measurements (SLOC, cyclomatic, method-count),
  // not behavioral pass/fail contracts. "partial" reflects this accurately.
  return entry.ruleKind === "architecture" ? "hard" : "partial";
}

/**
 * Format design-origin lines for human output.
 * Returns an array of formatted strings, or an empty array if no origin.
 */
export function formatDesignOriginLines(origin: DesignOriginInfo | null): string[] {
  if (!origin) return [];

  const lines = [
    `Design origin: design profile section "${origin.profileSection}"`,
    `Generated from: ${origin.origin} (${origin.ruleKind})`,
    `Enforcement level: ${origin.enforcementLevel}${origin.enforcementLevel === "hard" ? " — requires design profile update to disable" : ""}`,
  ];
  return lines;
}

/**
 * Build design-origin object for JSON output.
 */
export function buildDesignOriginJson(origin: DesignOriginInfo | null): Record<string, unknown> | null {
  if (!origin) return null;

  return {
    profile_section: origin.profileSection,
    origin: origin.origin,
    enforcement_level: origin.enforcementLevel,
    rule_kind: origin.ruleKind,
  };
}
