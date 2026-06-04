import { minimatch } from "minimatch";
import { type BoundaryDeclaration, type Violation } from "@stele/core";
import {
  createRuleViolation,
  createScopePaths,
  normalizeRelativePath,
  type PythonFileAnalysis,
} from "./code-shape-common.js";

export function evaluateBoundaryDeclaration(
  declaration: BoundaryDeclaration,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
  contractPath: string,
  command: string,
): Violation[] {
  if (matchedFiles.length === 0) {
    return [
      createRuleViolation({
        declaration,
        command,
        contractPath,
        filePath: declaration.target.split("::")[0],
        summary: `Boundary "${declaration.id}" matched no files.`,
        detail: `Target pattern "${declaration.target}" did not match any Python files in the project.`,
        fixSummary: `Update the target pattern or ensure matching files exist.`,
        scopePaths: createScopePaths(contractPath, matchedFiles, declaration.target),
      }),
    ];
  }

  const violations: Violation[] = [];

  for (const filePath of matchedFiles) {
    if (declaration.allowTargets.some((pattern) => matchesPathPattern(filePath, pattern))) {
      continue;
    }

    const analysis = fileAnalyses.get(filePath);

    if (analysis === undefined) {
      continue;
    }

    for (const imported of analysis.imports) {
      const deniedImport = declaration.denyImports.find((pattern) => imported.candidates.some((candidate) => matchesImportPattern(candidate, pattern)));

      if (deniedImport !== undefined) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath,
            line: imported.line,
            column: imported.column,
            summary: `Forbidden import "${deniedImport}" appears in "${filePath}".`,
            detail: `Boundary "${declaration.id}" blocks imports matching "${deniedImport}".`,
            fixSummary: `Remove the forbidden import from "${filePath}" or add a narrower allow-target if this file is intentionally exempt.`,
          }),
        );
      }
    }

    for (const called of analysis.calls) {
      const deniedCall = declaration.denyCalls.find((pattern) => minimatch(called.name, pattern));

      if (deniedCall !== undefined) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath,
            line: called.line,
            column: called.column,
            summary: `Forbidden call "${called.name}" appears in "${filePath}".`,
            detail: `Boundary "${declaration.id}" blocks calls matching "${deniedCall}".`,
            fixSummary: `Replace the forbidden call in "${filePath}" or relax boundary "${declaration.id}" if that dependency is intentional.`,
          }),
        );
      }
    }
  }

  return violations;
}

function matchesImportPattern(candidate: string, deniedImport: string): boolean {
  return candidate === deniedImport || candidate.startsWith(`${deniedImport}.`);
}

function matchesPathPattern(path: string, pattern: string): boolean {
  return minimatch(path, normalizeRelativePath(pattern));
}
