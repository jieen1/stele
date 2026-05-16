import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SteleError } from "../errors/SteleError.js";
import { parseFile } from "../parser/parser.js";
import { validateReferences } from "../validator/references.js";
import {
  buildContract,
  collectImportDeclarations,
  type Contract,
  type LoadedContractFile,
} from "../validator/structure.js";
import { validateTypes } from "../validator/types.js";
import { validateUniqueness } from "../validator/uniqueness.js";

export async function loadContract(rootPath: string): Promise<Contract> {
  const normalizedRootPath = resolve(rootPath);
  const files = await loadRecursive(normalizedRootPath, new Map(), []);
  return validateContract(buildContract(normalizedRootPath, files));
}

export function validateContract(contract: Contract): Contract {
  let validated = validateUniqueness(contract);
  validated = validateReferences(validated);
  validateTypes(validated);
  return validated;
}

async function loadRecursive(
  filePath: string,
  visited: Map<string, LoadedContractFile>,
  stack: string[],
): Promise<LoadedContractFile[]> {
  if (visited.has(filePath)) {
    return [];
  }

  const source = await readContractFile(filePath);
  const parsed = parseFile(source, filePath);
  const loadedFile: LoadedContractFile = {
    path: filePath,
    parsed,
  };

  visited.set(filePath, loadedFile);
  stack.push(filePath);

  const loadedFiles: LoadedContractFile[] = [loadedFile];

  try {
    for (const declaration of collectImportDeclarations(filePath, parsed)) {
      if (stack.includes(declaration.resolvedPath)) {
        const cycle = [...stack, declaration.resolvedPath];
        throw new SteleError(
          "E0203",
          "Loader Error",
          "Circular import detected.",
          declaration.span,
          cycle.join(" -> "),
          "Break the import cycle by extracting shared declarations into a separate file.",
        );
      }

      loadedFiles.push(...(await loadRecursive(declaration.resolvedPath, visited, stack)));
    }
  } finally {
    stack.pop();
  }

  return loadedFiles;
}

async function readContractFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown read error.";

    throw new SteleError(
      "E0201",
      "Loader Error",
      `Unable to read contract file "${filePath}".`,
      undefined,
      detail,
      "Check that the file exists and that Stele has permission to read it.",
    );
  }
}
