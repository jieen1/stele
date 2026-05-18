import type { ArchitectureModuleDeclaration } from "@stele/architecture-core";
import { minimatch } from "minimatch";

export interface FileToModuleMap {
  fileToModule: Map<string, string>;
  unownedFiles: string[];
  ambiguousFiles: Array<{ file: string; modules: string[] }>;
}

/**
 * Build a file-to-module mapping from architecture module declarations.
 *
 * Each module declares path globs; files matching those globs are assigned to
 * the module. Files matching multiple module globs are reported as ambiguous.
 * Files matching no module glob are reported as unowned.
 */
export function buildModuleMap(
  files: string[],
  modules: ArchitectureModuleDeclaration[],
): FileToModuleMap {
  const fileToModule = new Map<string, string>();
  const unownedFiles: string[] = [];
  const ambiguousFiles: Array<{ file: string; modules: string[] }> = [];

  for (const file of files) {
    const matchingModules: string[] = [];

    for (const module of modules) {
      for (const pathPattern of module.paths) {
        if (minimatch(file, pathPattern)) {
          matchingModules.push(module.id);
          break;
        }
      }
    }

    if (matchingModules.length === 0) {
      unownedFiles.push(file);
    } else if (matchingModules.length === 1) {
      fileToModule.set(file, matchingModules[0]);
    } else {
      ambiguousFiles.push({ file, modules: matchingModules });
      // Assign to the first matching module to keep the graph functional
      fileToModule.set(file, matchingModules[0]);
    }
  }

  return { fileToModule, unownedFiles, ambiguousFiles };
}
