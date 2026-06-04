import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type FilePolicyDeclaration, type Violation } from "@stele/core";
import {
  createRuleViolation,
  createScopePaths,
  parseTarget,
} from "./code-shape-common.js";

export async function evaluateFilePolicyDeclaration(
  projectDir: string,
  declaration: FilePolicyDeclaration,
  matchedFiles: string[],
  contractPath: string,
  command: string,
): Promise<Violation[]> {
  const parsedTarget = parseTarget(declaration.target);
  const violations: Violation[] = [];

  if (matchedFiles.length === 0) {
    return [
      createRuleViolation({
        declaration,
        command,
        contractPath,
        filePath: parsedTarget.pathPattern,
        summary: `File policy "${declaration.id}" matched no files.`,
        detail: `No Python file matched "${parsedTarget.pathPattern}".`,
        fixSummary: `Create a file matched by "${parsedTarget.pathPattern}" or update the file-policy target.`,
        scopePaths: createScopePaths(contractPath, matchedFiles, parsedTarget.pathPattern),
      }),
    ];
  }

  for (const filePath of matchedFiles) {
    const content = await readFile(resolve(projectDir, filePath), "utf8");

    for (const requiredText of declaration.mustContain) {
      if (!content.includes(requiredText)) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath,
            line: 1,
            column: 1,
            summary: `File "${filePath}" must contain "${requiredText}".`,
            detail: `File policy "${declaration.id}" requires that exact text.`,
            fixSummary: `Add "${requiredText}" to "${filePath}".`,
          }),
        );
      }
    }

    for (const requiredEnding of declaration.mustEndWith) {
      if (!content.endsWith(requiredEnding)) {
        const endingLocation = computeFileEndingLocation(content);
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath,
            line: endingLocation.line,
            column: endingLocation.column,
            summary: `File "${filePath}" must end with ${JSON.stringify(requiredEnding)}.`,
            detail: `File policy "${declaration.id}" requires that exact file ending.`,
            fixSummary: `Update the trailing content of "${filePath}" so it ends with ${JSON.stringify(requiredEnding)}.`,
          }),
        );
      }
    }
  }

  return violations;
}

function computeFileEndingLocation(content: string): { line: number; column: number } {
  const lines = content.split("\n");
  const line = Math.max(lines.length, 1);
  const column = (lines.at(-1) ?? "").length + 1;
  return { line, column };
}
