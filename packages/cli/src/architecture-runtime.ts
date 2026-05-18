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

export type ArchitectureContractOptions = {
  projectRoot: string;
  architecture: {
    id: string;
    modules: MinimalModuleDeclaration[];
    allowDependencies: Array<{ from: string; to: string[] }>;
    denyCycles: boolean;
  };
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
// Main entry point
// ----------------------------------------------------------------

/**
 * Evaluate an architecture contract against the project's TypeScript source files.
 *
 * This is the public runtime entry point for generated architecture tests.
 * It loads source files, builds a dependency graph, and evaluates it against
 * the declared architecture constraints.
 *
 * All file paths are handled in POSIX format internally for consistent module
 * mapping. The TypeScript compiler API resolves absolute paths for imports,
 * but the module map keys remain relative POSIX paths for determinism.
 */
export async function evaluateArchitectureContract(
  options: ArchitectureContractOptions,
): Promise<ArchitectureViolation[]> {
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
  const extractor = createExtractor({ projectDir: projectRoot });
  const allEdges: DependencyEdge[] = [];

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

        const normalizedTo = isAbsoluteLikePath(rawTo)
          ? toProjectRelativePath(projectRoot, rawTo)
          : rawTo;

        const targetModule = moduleMap.fileToModule.get(normalizedTo);
        if (targetModule === undefined) continue;

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

  // Build architecture declaration
  const declaration: ArchitectureDeclaration = {
    kind: "architecture",
    id: architecture.id,
    lang: "typescript",
    modules: fullModules,
    layers: [],
    allowDependencies: architecture.allowDependencies.map((d) => ({
      ...d,
      span: EMPTY_SPAN,
    })),
    denyCycles: architecture.denyCycles,
  };

  // Build graph — now with populated modules
  const graph: ArchitectureGraph = {
    architectureId: architecture.id,
    modules,
    edges: allEdges,
    unownedFiles: [],
    ambiguousFiles: [],
    unresolvedSpecifiers: [],
  };

  // Evaluate
  const result = evaluateArchitecture(declaration, graph);

  // Convert violations
  const violations: ArchitectureViolation[] = [];

  for (const violation of result.violations) {
    violations.push({
      fromModule: violation.fromModule,
      toModule: violation.toModule,
      fromFile: violation.fromFile,
      specifier: violation.specifier,
      line: violation.line,
      column: violation.column,
    });
  }

  return violations;
}
