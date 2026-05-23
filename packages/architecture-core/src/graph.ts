import { relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import type {
  ArchitectureDeclaration,
  ArchitectureGraph,
  ArchitectureModuleDeclaration,
  DependencyEdge,
} from "./types.js";
import { createExtractor } from "./typescript-extractor.js";
import { expandBraces } from "./util.js";

/**
 * Normalize an absolute path back to a relative POSIX path from the project directory.
 */
function toProjectRelativePath(projectDir: string, absolutePath: string): string {
  return relative(projectDir, absolutePath).replaceAll("\\", "/");
}

/**
 * Match a file path to a module declaration by checking if any of the module's
 * paths are a prefix (or glob-match) of the file path.
 */
export function moduleBelongsToModule(
  file: string,
  modules: ArchitectureModuleDeclaration[],
): ArchitectureModuleDeclaration | null {
  for (const mod of modules) {
    for (const pattern of mod.paths) {
      if (pathMatchesPattern(file, pattern)) {
        return mod;
      }
    }
  }
  return null;
}

/**
 * Match a file against a glob pattern, with brace expansion support.
 * Uses minimatch for consistent behavior across all packages.
 */
function pathMatchesPattern(file: string, pattern: string): boolean {
  const expanded = expandBraces(pattern);
  for (const variant of expanded) {
    if (minimatch(file, variant)) {
      return true;
    }
  }
  return false;
}

/**
 * Build a map from file paths to their owning module id, plus unowned and ambiguous files.
 */
export function buildFileToModuleMap(
  modules: ArchitectureModuleDeclaration[],
  allFiles: string[],
): {
  fileToModule: Map<string, string>;
  unownedFiles: string[];
  ambiguousFiles: Array<{ file: string; modules: string[] }>;
} {
  const fileToModule = new Map<string, string>();
  const unownedFiles: string[] = [];
  const ambiguousFiles: Array<{ file: string; modules: string[] }> = [];

  for (const file of allFiles) {
    const owners: ArchitectureModuleDeclaration[] = [];

    for (const mod of modules) {
      for (const pattern of mod.paths) {
        if (pathMatchesPattern(file, pattern)) {
          owners.push(mod);
        }
      }
    }

    if (owners.length === 0) {
      unownedFiles.push(file);
    } else if (owners.length === 1) {
      fileToModule.set(file, owners[0]!.id);
    } else {
      // Ambiguous: file claimed by multiple modules
      const moduleIds = owners.map((m) => m.id);
      ambiguousFiles.push({ file, modules: moduleIds });
      // Still assign to the first matching module for edge extraction
      fileToModule.set(file, owners[0]!.id);
    }
  }

  return { fileToModule, unownedFiles, ambiguousFiles };
}

/**
 * Build the full architecture graph from an architecture declaration, project directory,
 * and file contents map.
 *
 * Uses the TypeScript compiler API for import extraction — no regex-based parsing.
 */
export async function buildArchitectureGraph(
  declaration: ArchitectureDeclaration,
  projectDir: string,
  fileContents: Map<string, string>,
): Promise<ArchitectureGraph> {
  const allFiles = [...fileContents.keys()];

  // Build file-to-module mapping
  const { fileToModule, unownedFiles, ambiguousFiles } = buildFileToModuleMap(
    declaration.modules,
    allFiles,
  );

  // Build modules record (module id -> file list)
  const modules: Record<string, string[]> = {};
  for (const mod of declaration.modules) {
    modules[mod.id] = [];
  }
  for (const [file, moduleId] of fileToModule) {
    if (modules[moduleId] !== undefined) {
      modules[moduleId].push(file);
    }
  }

  // Create TS-based import extractor
  const extractor = await createExtractor({
    projectDir,
    tsconfigPath: declaration.tsconfig ? `${projectDir}/${declaration.tsconfig}` : undefined,
  });

  // Extract dependency edges from each owned file
  const edges: DependencyEdge[] = [];
  const unresolvedSpecifiers: Array<{
    fromFile: string;
    specifier: string;
    line: number;
    column: number;
  }> = [];

  // Normalize projectDir once, to POSIX, for reliable prefix matching.
  // On Windows, resolve() returns backslashes but TS resolveModuleName may
  // return paths with different casing or separators. Normalizing both sides
  // ensures the startsWith check is cross-platform robust.
  const projectDirPosix = projectDir.replace(/\\/g, "/");

  for (const file of allFiles) {
    const owningModule = fileToModule.get(file);
    if (owningModule === undefined) {
      continue; // unowned files don't produce edges
    }

    const content = fileContents.get(file);
    if (content === undefined) {
      continue;
    }

    // TS compiler API needs absolute paths for module resolution.
    const absoluteFile = resolve(projectDir, file);
    const fileEdges = extractor.extractImports(absoluteFile, content);

    for (const edge of fileEdges) {
      // resolveModuleName returns absolute paths — normalize back to relative POSIX.
      const rawTargetFile = edge.toFile;

      // Skip external packages (node_modules) and unresolved imports silently.
      // Only internal project imports participate in architecture evaluation.
      if (rawTargetFile === undefined || rawTargetFile.includes("node_modules")) {
        continue;
      }

      // Check the target is inside the project directory.
      // Normalize both sides to POSIX for reliable comparison on Windows.
      const targetPosix = rawTargetFile.replace(/\\/g, "/");
      if (!targetPosix.startsWith(projectDirPosix)) {
        continue;
      }

      // Convert to relative POSIX path. Use the POSIX-normalized versions
      // to avoid path-separator mismatches on Windows.
      const normalizedTarget = toProjectRelativePath(projectDirPosix, targetPosix);

      const targetModule = fileToModule.get(normalizedTarget);

      if (targetModule === undefined) {
        // Resolved to a file not owned by any module in this architecture.
        // This is a cross-architecture dependency (e.g. cli → core). Skip it
        // silently — each bounded context only evaluates its own modules.
        continue;
      }

      // Populate module-level edge data
      edges.push({
        ...edge,
        fromModule: owningModule,
        toModule: targetModule,
        fromFile: file,
        toFile: normalizedTarget,
      });
    }
  }

  return {
    architectureId: declaration.id,
    modules,
    edges,
    unownedFiles,
    ambiguousFiles,
    unresolvedSpecifiers,
  };
}
