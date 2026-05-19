import { createViolationReport } from "@stele/core";
import type { Violation, ViolationReport } from "@stele/core";
import { evaluateArchitectureContract, type ArchitectureContractOptions } from "../architecture-runtime.js";
import type { PreparedCheckContext, ProtectedCheckState } from "../commands/check.js";

/**
 * Build the architecture stage report for the check pipeline.
 *
 * Loads architecture declarations from the contract, evaluates each one
 * against the real TypeScript dependency graph, and returns violations.
 */
export async function buildArchitectureStageReport(
  context: PreparedCheckContext,
  _protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const architectures = context.contract.architectures;

  if (architectures.length === 0) {
    // No architecture declarations — nothing to check
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        violation_count: 0,
      },
      violations: [],
    });
  }

  const allViolations: Violation[] = [];

  for (const arch of architectures) {
    // Convert parsed architecture declaration to runtime options
    const runtimeArch = convertToRuntimeArch(arch);
    const violations = await evaluateArchitectureContract({
      projectRoot: context.projectDir,
      architecture: runtimeArch,
    });

    // Map runtime violations to Stele Violations
    for (const v of violations) {
      const detail = `Architecture violation: module "${v.fromModule}" imports from "${v.toModule}" via ${v.specifier} at ${v.fromFile}:${v.line}:${v.column}`;
      const violation: Violation = {
        rule_id: `architecture.${arch.id}.${v.fromModule}.${v.toModule}`,
        rule_kind: "architecture_dependency" as const,
        severity: "error" as const,
        source: { tool: "stele", command, kind: "architecture" },
        location: { path: v.fromFile, line: v.line, column: v.column },
        cause: { summary: detail },
        fingerprint: `${v.fromModule}→${v.toModule}:${v.fromFile}`,
        scope_paths: [v.fromFile],
        status: "active" as const,
        fix: { summary: `Remove the import of "${v.specifier}" or move the file to an allowed module.` },
      };
      allViolations.push(violation);
    }
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: allViolations.length === 0,
    summary: {
      violation_count: allViolations.length,
    },
    violations: allViolations,
  });
}

/**
 * Convert a parsed ArchitectureDeclaration to the runtime options shape.
 */
function convertToRuntimeArch(arch: {
  id: string;
  modules: { id: string; paths: string[] }[];
  allowDependencies: Array<{ from: string; to: string[] }>;
  denyCycles: boolean;
}): ArchitectureContractOptions["architecture"] {
  return {
    id: arch.id,
    modules: arch.modules.map((m) => ({
      id: m.id,
      paths: m.paths,
    })),
    allowDependencies: arch.allowDependencies,
    denyCycles: arch.denyCycles,
  };
}
