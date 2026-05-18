import type {
  ArchitectureDeclaration,
  ArchitectureGraph,
  ArchitectureModuleDeclaration,
  DependencyEdge,
} from "./types.js";
import { createExtractor } from "./typescript-extractor.js";

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
 * Minimal glob matcher supporting `*` and `**`.
 * `*` matches anything except `/`, `**` matches anything including `/`.
 */
function pathMatchesPattern(path: string, pattern: string): boolean {
  // Normalize to forward slashes
  const p = path.replace(/\\/g, "/");
  const pat = pattern.replace(/\\/g, "/");

  // Convert glob pattern to regex
  const regex = globToRegex(pat);
  return regex.test(p);
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        // **
        if (i + 2 < pattern.length && pattern[i + 2] === "/") {
          // **/ — matches zero or more directories
          regex += "(?:[^/]+/)*";
          i += 3;
        } else {
          // ** at end
          regex += ".*";
          i += 2;
        }
      } else {
        // * — matches anything except /
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (ch === "." || ch === "+" || ch === "(" || ch === ")" || ch === "|" || ch === "^" || ch === "$") {
      regex += "\\" + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }

  return new RegExp(`^${regex}$`);
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
export function buildArchitectureGraph(
  declaration: ArchitectureDeclaration,
  projectDir: string,
  fileContents: Map<string, string>,
): ArchitectureGraph {
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
  const extractor = createExtractor({
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

  for (const file of allFiles) {
    const owningModule = fileToModule.get(file);
    if (owningModule === undefined) {
      continue; // unowned files don't produce edges
    }

    const content = fileContents.get(file);
    if (content === undefined) {
      continue;
    }

    const fileEdges = extractor.extractImports(file, content);

    for (const edge of fileEdges) {
      const targetFile = edge.toFile;
      const targetModule = targetFile !== undefined ? fileToModule.get(targetFile) : undefined;

      if (targetModule === undefined) {
        // Unresolved or unowned target
        unresolvedSpecifiers.push({
          fromFile: edge.fromFile,
          specifier: edge.specifier,
          line: edge.line,
          column: edge.column,
        });
        continue;
      }

      // Populate module-level edge data
      edges.push({
        ...edge,
        fromModule: owningModule,
        toModule: targetModule,
        toFile: targetFile ?? undefined,
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
