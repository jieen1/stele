import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateArchitecture, buildArchitectureGraph } from "@stele/architecture-core";
import { createViolationReport } from "@stele/core";
import type { Violation, ViolationReport } from "@stele/core";
import { evaluateArchitectureContract, type ArchitectureContractOptions } from "../architecture-runtime.js";
import { safeGlob } from "../utils/glob.js";
import type { PreparedCheckContext, ProtectedCheckState } from "../commands/check.js";

/**
 * Build the architecture stage report for the check pipeline.
 *
 * Loads architecture declarations from the contract, evaluates each one
 * against the real TypeScript dependency graph, and returns violations.
 * Surfaces both dependency violations and cycle violations.
 */
export async function buildArchitectureStageReport(
  context: PreparedCheckContext,
  _protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const architectures = context.contract.architectures;

  if (architectures.length === 0) {
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
    const runtimeArch = convertToRuntimeArch(arch);
    const violations = await evaluateArchitectureContract({
      projectRoot: context.projectDir,
      architecture: runtimeArch,
    });

    // Dependency violations
    for (const v of violations) {
      const prefix = arch.description ? `${arch.description}. ` : "";
      const detail = `${prefix}Architecture violation: module "${v.fromModule}" imports from "${v.toModule}" via ${v.specifier} at ${v.fromFile}:${v.line}:${v.column}`;
      const fixSummary = arch.fix
        ? arch.fix
        : `Remove the import of "${v.specifier}" or move the file to an allowed module.`;
      allViolations.push({
        rule_id: `architecture.${arch.id}.${v.fromModule}.${v.toModule}`,
        rule_kind: "architecture_dependency" as const,
        severity: "error" as const,
        source: { tool: "stele", command, kind: "architecture" },
        location: { path: v.fromFile, line: v.line, column: v.column },
        cause: { summary: detail },
        fingerprint: `${v.fromModule}→${v.toModule}:${v.fromFile}`,
        scope_paths: [v.fromFile],
        status: "active" as const,
        fix: { summary: fixSummary },
      });
    }

    // Cycle violations (from evaluateArchitecture result)
    const cycleViolations = await evaluateCycleViolations(
      context.projectDir,
      runtimeArch,
      arch,
      command,
    );
    for (const cv of cycleViolations) {
      allViolations.push(cv);
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
 * Evaluate cycle violations for an architecture declaration.
 * Returns violations with rule_kind "architecture_cycle".
 */
async function evaluateCycleViolations(
  projectRoot: string,
  runtimeArch: ArchitectureContractOptions["architecture"],
  arch: { fix?: string; description?: string },
  command: string,
): Promise<Violation[]> {
  if (!runtimeArch.denyCycles) {
    return [];
  }

  // Discover source files
  const allFiles: string[] = [];
  for (const mod of runtimeArch.modules) {
    for (const pathPattern of mod.paths) {
      const files = safeGlob(pathPattern, { projectDir: projectRoot });
      allFiles.push(...files);
    }
  }
  const uniqueFiles = [...new Set(allFiles)].sort();

  // Build file contents map for graph builder
  const fileContents = new Map<string, string>();
  for (const file of uniqueFiles) {
    try {
      const absPath = resolve(projectRoot, file);
      const content = await readFile(absPath, "utf8");
      fileContents.set(file, content);
    } catch {
      // Skip unreadable files
    }
  }

  // Build declaration for graph builder
  const declaration: import("@stele/architecture-core").ArchitectureDeclaration = {
    kind: "architecture",
    id: runtimeArch.id,
    lang: "typescript",
    tsconfig: runtimeArch.tsconfig,
    modules: runtimeArch.modules.map((m) => ({
      id: m.id,
      paths: m.paths,
      publicEntries: [],
      span: { file: "", line: 0, column: 0 },
    })),
    layers: [],
    allowDependencies: runtimeArch.allowDependencies.map((d) => ({
      ...d,
      span: { file: "", line: 0, column: 0 },
    })),
    denyCycles: runtimeArch.denyCycles,
  };

  const graph = buildArchitectureGraph(declaration, projectRoot, fileContents);
  const result = evaluateArchitecture(declaration, graph);

  const violations: Violation[] = [];
  for (const cycle of result.cycleViolations) {
    const modulesStr = cycle.modules.join(" → ");
    const fileStr = cycle.edgeFiles.length > 0 ? cycle.edgeFiles.join(", ") : "multiple files";
    const prefix = arch.description ? `${arch.description}. ` : "";
    const summary = `${prefix}Architecture cycle: ${modulesStr} (files: ${fileStr})`;

    const firstFile = cycle.edgeFiles[0] ?? "";
    const fixSummary = arch.fix
      ? arch.fix
      : `Break the cycle by refactoring the dependency between modules: ${modulesStr}`;

    violations.push({
      rule_id: `architecture.${runtimeArch.id}.cycle.${cycle.modules.sort().join(".")}`,
      rule_kind: "architecture_cycle" as const,
      severity: "error" as const,
      source: { tool: "stele", command, kind: "architecture" },
      location: { path: firstFile },
      cause: { summary },
      fingerprint: `architecture_cycle.${runtimeArch.id}.${cycle.modules.sort().join(".")}`,
      scope_paths: cycle.edgeFiles,
      status: "active" as const,
      fix: { summary: fixSummary },
    });
  }

  return violations;
}

/**
 * Convert a parsed ArchitectureDeclaration to the runtime options shape.
 */
function convertToRuntimeArch(arch: {
  id: string;
  modules: { id: string; paths: string[] }[];
  allowDependencies: Array<{ from: string; to: string[] }>;
  denyCycles: boolean;
  tsconfig?: string;
  description?: string;
}): ArchitectureContractOptions["architecture"] {
  return {
    id: arch.id,
    modules: arch.modules.map((m) => ({
      id: m.id,
      paths: m.paths,
    })),
    allowDependencies: arch.allowDependencies,
    denyCycles: arch.denyCycles,
    tsconfig: arch.tsconfig,
  };
}
