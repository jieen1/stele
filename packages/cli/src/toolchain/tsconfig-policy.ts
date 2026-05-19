// tsconfig.json policy validator — checks required compiler options.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolchainConfigOptions, ToolchainViolation } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateTsconfigPolicy(
  projectDir: string,
  tsconfigPath: string,
  requiredOptions: ToolchainConfigOptions,
): ToolchainViolation[] {
  const violations: ToolchainViolation[] = [];

  const absolutePath = resolve(projectDir, tsconfigPath);
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = parseTsconfig(raw);

  const compilerOptions = parsed.compilerOptions ?? {};

  for (const [key, requiredValue] of Object.entries(requiredOptions)) {
    const actual = compilerOptions[key];

    if (actual === requiredValue) {
      // Option is present and set to the required value — no violation.
      continue;
    }

    const optionName = mapOptionToName(key);
    const ruleId = `typedriven.typescript.config.${optionName}`;

    violations.push({
      ruleId,
      ruleKind: "typescript-config-policy",
      file: tsconfigPath,
      message: `${tsconfigPath}: ${key} is ${formatValue(actual)} but required to be ${formatValue(requiredValue)} by design profile`,
      severity: "error",
      fix: `Set "${key}" to ${JSON.stringify(requiredValue)} in ${tsconfigPath}`,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type TsconfigJson = {
  compilerOptions?: Record<string, unknown>;
};

function parseTsconfig(raw: string): TsconfigJson {
  const parsed = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null ? (parsed as TsconfigJson) : {};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapOptionToName(key: string): string {
  const map: Record<string, string> = {
    strict: "strict",
    exactOptionalPropertyTypes: "exactOptionalPropertyTypes",
    noUncheckedIndexedAccess: "noUncheckedIndexedAccess",
  };
  return map[key] ?? key;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  return String(value);
}
