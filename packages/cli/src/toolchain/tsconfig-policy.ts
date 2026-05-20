// tsconfig.json policy validator — checks required compiler options.
// Uses the TypeScript compiler API (ts.readConfigFile) to properly parse
// tsconfig files, including extended configs.

import { lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ToolchainConfigOptions, ToolchainViolation } from "./types.js";
import * as ts from "typescript";

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
  const resolvedOptions = resolveTsconfig(absolutePath);

  for (const [key, requiredValue] of Object.entries(requiredOptions)) {
    const actual = resolvedOptions[key];

    if (actual === requiredValue) {
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
// Tsconfig resolution (handles extends chain)
// ---------------------------------------------------------------------------

/**
 * Resolve a tsconfig file using the TypeScript compiler API.
 * Returns the merged compilerOptions, handling the extends chain recursively.
 */
function resolveTsconfig(absolutePath: string): Record<string, unknown> {
  const readResult = ts.readConfigFile(absolutePath, ts.sys.readFile);

  if (readResult.error && !readResult.config) {
    return {};
  }

  const config = readResult.config;
  if (!config || typeof config !== "object") {
    return {};
  }

  const currentOptions = (config.compilerOptions ?? {}) as Record<string, unknown>;

  // Handle extends chain: recursively resolve parent, then overlay child
  const extendsPath = config.extends;
  if (typeof extendsPath === "string") {
    const parentPath = resolveExtendsPath(absolutePath, extendsPath);
    if (parentPath) {
      const parentOptions = resolveTsconfig(parentPath);
      // Child options override parent options
      return { ...parentOptions, ...currentOptions };
    }
  }

  return currentOptions;
}

/**
 * Resolve the path of an extended tsconfig.
 */
function resolveExtendsPath(basePath: string, extendsPath: string): string | undefined {
  if (extendsPath.startsWith(".")) {
    return resolve(dirname(basePath), extendsPath);
  }

  // For node_modules packages, try resolving relative to the base directory
  const nodeModulesPath = resolve(dirname(basePath), "node_modules", extendsPath);
  try {
    lstatSync(nodeModulesPath + ".json");
    return nodeModulesPath + ".json";
  } catch {
    // ignore
  }
  try {
    lstatSync(nodeModulesPath);
    return nodeModulesPath;
  } catch {
    // ignore
  }
  return undefined;
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
