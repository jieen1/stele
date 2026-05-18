import type { ArchitectureDeclaration } from "@stele/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MinimalModule = {
  id: string;
  paths: string[];
};

export type MinimalAllowDependency = {
  from: string;
  to: string[];
};

export type MinimalArchitecture = {
  id: string;
  modules: MinimalModule[];
  allowDependencies: MinimalAllowDependency[];
  denyCycles: boolean;
};

/**
 * Convert a core `ArchitectureDeclaration` to the minimal shape the generated
 * test runtime consumes.
 */
export function toMinimalArchitecture(architecture: ArchitectureDeclaration): MinimalArchitecture {
  return {
    id: architecture.id,
    modules: architecture.modules.map((mod) => ({
      id: mod.id,
      paths: mod.paths,
    })),
    allowDependencies: architecture.allowDependencies.map((dep) => ({
      from: dep.from,
      to: dep.to,
    })),
    denyCycles: architecture.denyCycles,
  };
}

// ---------------------------------------------------------------------------
// Safe JSON → TypeScript literal
// ---------------------------------------------------------------------------

/**
 * Serialize a plain value to a TypeScript-safe literal that can be embedded in
 * generated source code.
 */
function toTsLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const INDENT = "  ";

interface ArchitectureRendererOptions {
  /** The architecture definition to embed. */
  architecture: MinimalArchitecture;
  /**
   * Path to the directory containing the project root, used to compute the
   * relative import for the runtime helper. Defaults to `"../../.."` which
   * assumes the generated test lives at `tests/contract/`.
   */
  runtimeImportPath?: string;
}

/**
 * Render a Vitest test file for an architecture contract.
 *
 * The generated file:
 * 1. Imports `describe`, `test`, `expect` from vitest.
 * 2. Imports `evaluateArchitectureContract` from `@stele/cli/architecture-runtime`.
 * 3. Embeds the architecture definition as a JS object.
 * 4. Tests "architecture constraints are satisfied" — calls the runtime and
 *    asserts zero violations.
 */
export function renderArchitectureTest(options: ArchitectureRendererOptions): string {
  const { architecture, runtimeImportPath = "@stele/cli/architecture-runtime" } = options;

  const lines: string[] = [];

  // Imports
  lines.push('import { describe, test, expect } from "vitest";');
  lines.push('import { resolve, dirname } from "node:path";');
  lines.push('import { fileURLToPath } from "node:url";');
  lines.push(`import { evaluateArchitectureContract } from "${runtimeImportPath}";`);
  lines.push("");

  // Compute projectRoot from the generated test file location.
  // The test lives at `tests/contract/test_arch_<id>.ts`, so the project root
  // is three levels up: `../../..`.
  lines.push(
    "const __projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), \"../../..\");",
  );
  lines.push("");

  // Architecture literal
  const archLiteral = toTsLiteral(architecture);
  lines.push(`const stele_architecture = ${archLiteral};`);
  lines.push("");

  // Test describe block
  const archId = architecture.id;
  lines.push(`describe("Architecture: ${archId}", () => {`);
  lines.push(
    `${INDENT}test("architecture constraints are satisfied", async () => {`,
  );
  lines.push(
    `${INDENT}${INDENT}const violations = await evaluateArchitectureContract({`,
  );
  lines.push(`${INDENT}${INDENT}${INDENT}projectRoot: __projectRoot,`);
  lines.push(`${INDENT}${INDENT}${INDENT}architecture: stele_architecture,`);
  lines.push(`${INDENT}${INDENT}});`);
  lines.push(`${INDENT}${INDENT}if (violations.length > 0) {`);
  lines.push(
    `${INDENT}${INDENT}${INDENT}const detail = violations.map((v) => v.fromModule + " -> " + v.toModule + " at " + v.fromFile + ":" + v.line).join("\\n  ");`,
  );
  lines.push(
    `${INDENT}${INDENT}${INDENT}expect(violations.length, "Found architecture violations:\\n  " + detail).toBe(0);`,
  );
  lines.push(`${INDENT}${INDENT}}`);
  lines.push(`${INDENT}});`);
  lines.push(`});`);
  lines.push("");

  return lines.join("\n");
}
