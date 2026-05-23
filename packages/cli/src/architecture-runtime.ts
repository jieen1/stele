import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateArchitecture } from "@stele/architecture-core";
import type {
  ArchitectureDeclaration,
  ArchitectureGraph,
  DependencyEdge,
} from "@stele/architecture-core";
import type { SourceSpan } from "@stele/core";
import { isAbsoluteLikePath, toProjectRelativePath } from "./utils/shared-utils.js";
import { safeGlob } from "./utils/glob.js";
import { createExtractor } from "./architecture/typescript-extractor.js";
import { buildModuleMap } from "./architecture/module-map.js";

// ----------------------------------------------------------------
// Input types (minimal — no span/publicEntries required)
// ----------------------------------------------------------------

export type MinimalModuleDeclaration = {
  id: string;
  paths: string[];
};

export type MinimalLayerDeclaration = {
  id: string;
  modules: string[];
};

export type ArchitectureContractOptions = {
  projectRoot: string;
  architecture: {
    id: string;
    modules: MinimalModuleDeclaration[];
    layers?: MinimalLayerDeclaration[];
    allowDependencies: Array<{ from: string; to: string[] }>;
    denyCycles: boolean;
    tsconfig?: string;
  };
};

/**
 * Options accepted by {@link evaluateArchitectureRuntime}. Currently the
 * runtime always produces the full structured result; `fullDetails` is
 * reserved for future detail-toggling without breaking the call signature.
 */
export type ArchitectureRuntimeOptions = ArchitectureContractOptions & {
  /** Reserved: currently the runtime always returns full structured details. */
  fullDetails?: boolean;
};

export type ArchitectureViolation = {
  fromModule: string;
  toModule: string;
  fromFile: string;
  specifier: string;
  line: number;
  column: number;
};

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const EMPTY_SPAN: SourceSpan = { file: "", line: 0, column: 0 };

/**
 * Convert minimal module declarations to full declarations with defaults.
 */
function toFullModules(
  modules: MinimalModuleDeclaration[],
): Array<{ id: string; paths: string[]; publicEntries: string[]; span: SourceSpan }> {
  return modules.map((m) => ({
    ...m,
    publicEntries: [],
    span: EMPTY_SPAN,
  }));
}

// ----------------------------------------------------------------
// Result shape (used by stage.ts and public API)
// ----------------------------------------------------------------

export type ArchitectureRuntimeResult = {
  dependencyViolations: ArchitectureViolation[];
  cycleViolations: import("@stele/architecture-core").CycleViolation[];
  layerDirectionViolations: import("@stele/architecture-core").LayerDirectionViolation[];
  publicEntryViolations: import("@stele/architecture-core").PublicEntryViolation[];
  unownedFiles: string[];
  ambiguousFiles: Array<{ file: string; modules: string[] }>;
};

/**
 * @deprecated Renamed to {@link ArchitectureRuntimeResult}. Will be removed in v0.4.
 */
export type ArchitectureEvaluationResult = ArchitectureRuntimeResult;

/**
 * Evaluate an architecture declaration against the project's TypeScript source
 * tree. Returns a structured result with every violation kind. Single source of
 * truth for file discovery, graph building, and evaluation.
 *
 * All file paths are handled in POSIX format internally for consistent module
 * mapping. The TypeScript compiler API resolves absolute paths for imports,
 * but the module map keys remain relative POSIX paths for determinism.
 */
export async function evaluateArchitectureRuntime(
  options: ArchitectureRuntimeOptions,
): Promise<ArchitectureRuntimeResult> {
  const { projectRoot, architecture } = options;

  // Discover source files across all module paths (relative POSIX paths)
  const allFiles: string[] = [];
  for (const module of architecture.modules) {
    for (const pathPattern of module.paths) {
      const files = safeGlob(pathPattern, { projectDir: projectRoot });
      allFiles.push(...files);
    }
  }

  // Remove duplicates and sort for determinism
  const uniqueFiles = [...new Set(allFiles)].sort();

  // Build file-to-module mapping (keys are relative POSIX paths)
  const fullModules = toFullModules(architecture.modules);
  const moduleMap = buildModuleMap(uniqueFiles, fullModules);

  // Create extractor once (outside the loop) — avoids O(n * compilerInit)
  const tsconfigPath = architecture.tsconfig
    ? resolve(projectRoot, architecture.tsconfig)
    : undefined;
  const extractor = await createExtractor({ projectDir: projectRoot, tsconfigPath });
  const allEdges: DependencyEdge[] = [];
  const unresolvedSpecifiers: Array<{ fromFile: string; specifier: string; line: number; column: number }> = [];

  // Build modules record (module id -> file list) for the graph
  const modules: Record<string, string[]> = {};
  for (const m of fullModules) {
    modules[m.id] = [];
  }

  for (const file of uniqueFiles) {
    const absolutePath = resolve(projectRoot, file);
    try {
      const source = await readFile(absolutePath, "utf8");
      // TS API needs absolute path for resolution — safeGlob returns relative POSIX,
      // so we always use the absolute path here.
      const edges = extractor.extractImports(absolutePath, source);

      for (const edge of edges) {
        // edge.toFile may be absolute (TS resolution) — normalize to relative POSIX
        const rawTo = edge.toFile;
        if (rawTo === undefined) continue;

        // Skip external packages (node_modules) silently — they are not part of DDD evaluation
        if (rawTo.includes("node_modules")) {
          continue;
        }

        const normalizedTo = isAbsoluteLikePath(rawTo)
          ? toProjectRelativePath(projectRoot, rawTo)
          : rawTo;

        const targetModule = moduleMap.fileToModule.get(normalizedTo);
        if (targetModule === undefined) {
          // Resolved to a file not owned by any module in this architecture.
          // This is a cross-architecture dependency (e.g. cli → core). Skip it
          // silently — each bounded context only evaluates its own modules.
          continue;
        }

        const owningModule = moduleMap.fileToModule.get(file);
        if (owningModule === undefined) continue;

        allEdges.push({
          ...edge,
          fromModule: owningModule,
          toModule: targetModule,
          fromFile: file,
          toFile: normalizedTo,
        });
        if (modules[targetModule] !== undefined && !modules[targetModule].includes(normalizedTo)) {
          modules[targetModule].push(normalizedTo);
        }
      }
    } catch {
      // Skip files that cannot be read
      continue;
    }
  }

  // Build architecture declaration — layers and publicEntries now populated from
  // the generated DDD file so that layer direction and public-entry checks run.
  const layers: import("@stele/architecture-core").ArchitectureLayerDeclaration[] =
    (architecture.layers ?? []).map((l) => ({
      id: l.id,
      modules: l.modules,
      span: EMPTY_SPAN,
    }));

  const declaration: ArchitectureDeclaration = {
    kind: "architecture",
    id: architecture.id,
    lang: "typescript",
    modules: fullModules,
    layers,
    allowDependencies: architecture.allowDependencies.map((d) => ({
      ...d,
      span: EMPTY_SPAN,
    })),
    denyCycles: architecture.denyCycles,
  };

  // Build graph — propagate unowned and ambiguous files from module map
  const graph: ArchitectureGraph = {
    architectureId: architecture.id,
    modules,
    edges: allEdges,
    unownedFiles: moduleMap.unownedFiles,
    ambiguousFiles: moduleMap.ambiguousFiles,
    unresolvedSpecifiers,
  };

  // Evaluate — single evaluation, all violation types
  const result = evaluateArchitecture(declaration, graph);

  // Convert dependency violations
  const dependencyViolations: ArchitectureViolation[] = [];
  for (const violation of result.violations) {
    dependencyViolations.push({
      fromModule: violation.fromModule,
      toModule: violation.toModule,
      fromFile: violation.fromFile,
      specifier: violation.specifier,
      line: violation.line,
      column: violation.column,
    });
  }

  // Surface ambiguous files
  const ambiguousFiles = moduleMap.ambiguousFiles;

  return {
    dependencyViolations,
    cycleViolations: result.cycleViolations,
    layerDirectionViolations: result.layerDirectionViolations,
    publicEntryViolations: result.publicEntryViolations,
    unownedFiles: moduleMap.unownedFiles,
    ambiguousFiles,
  };
}

// ----------------------------------------------------------------
// Deprecated re-exports (one-version back-compat for external callers)
// ----------------------------------------------------------------

/**
 * @deprecated Use {@link evaluateArchitectureRuntime} instead. Will be removed in v0.4.
 */
export const evaluateArchitectureFull = evaluateArchitectureRuntime;

/**
 * @deprecated Use {@link evaluateArchitectureRuntime} and flatten the structured
 *             result at the call site instead. Will be removed in v0.4.
 *
 * Flattens every violation kind into a single `ArchitectureViolation[]` list,
 * preserving the historical wire shape used by older callers.
 */
export async function evaluateArchitectureContract(
  options: ArchitectureContractOptions,
): Promise<ArchitectureViolation[]> {
  const result = await evaluateArchitectureRuntime(options);
  const violations: ArchitectureViolation[] = [];

  // Dependency violations
  for (const v of result.dependencyViolations) {
    violations.push(v);
  }

  // Cycle violations — report each edge in the cycle as a separate violation
  for (const cycleViolation of result.cycleViolations) {
    for (let i = 0; i < cycleViolation.modules.length - 1; i++) {
      violations.push({
        fromModule: cycleViolation.modules[i],
        toModule: cycleViolation.modules[i + 1],
        fromFile: cycleViolation.edgeFiles[i] ?? cycleViolation.edgeFiles[0] ?? "",
        specifier: `cycle: ${cycleViolation.modules.join(" -> ")}`,
        line: 0,
        column: 0,
      });
    }
  }

  // Layer direction violations
  for (const ldv of result.layerDirectionViolations) {
    violations.push({
      fromModule: ldv.fromModule,
      toModule: ldv.toModule,
      fromFile: ldv.fromFile,
      specifier: ldv.specifier,
      line: ldv.line,
      column: ldv.column,
    });
  }

  // Public entry violations
  for (const pev of result.publicEntryViolations) {
    violations.push({
      fromModule: pev.fromModule,
      toModule: pev.toModule,
      fromFile: pev.fromFile,
      specifier: pev.specifier,
      line: pev.line,
      column: pev.column,
    });
  }

  // Ambiguous files as configuration violations
  for (const entry of result.ambiguousFiles) {
    violations.push({
      fromModule: entry.modules[0] ?? "",
      toModule: entry.modules[1] ?? "",
      fromFile: entry.file,
      specifier: `ambiguous: owned by ${entry.modules.join(", ")}`,
      line: 0,
      column: 0,
    });
  }

  return violations;
}
