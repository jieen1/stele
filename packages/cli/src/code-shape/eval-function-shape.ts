import { minimatch } from "minimatch";
import { type FunctionShapeDeclaration, type Violation } from "@stele/core";
import {
  collectFunctionMatches,
  createConfigurationViolation,
  createRuleViolation,
  createScopePaths,
  matchesNamedReference,
  parseTarget,
  type ParsedTarget,
  type PythonFileAnalysis,
  type SelectorValidation,
} from "./code-shape-common.js";

export function evaluateFunctionShapeDeclaration(
  declaration: FunctionShapeDeclaration,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
  contractPath: string,
  command: string,
): Violation[] {
  const parsedTarget = parseTarget(declaration.target);
  const selectorValidation = validateFunctionSelector(declaration.id, parsedTarget);

  if (selectorValidation.error !== undefined) {
    return [createConfigurationViolation(contractPath, declaration.id, selectorValidation.error, command)];
  }

  const functionMatches = collectFunctionMatches(parsedTarget, matchedFiles, fileAnalyses);

  if (functionMatches.length === 0) {
    const selectorLabel = parsedTarget.selectorName ?? `[${parsedTarget.selectorFilter}]`;
    return [
      createRuleViolation({
        declaration,
        command,
        contractPath,
        filePath: matchedFiles[0] ?? parsedTarget.pathPattern,
        summary: `Target function selector "${selectorLabel}" matched no Python functions.`,
        detail: `Function shape "${declaration.id}" expects a function inside "${parsedTarget.pathPattern}".`,
        fixSummary: `Add a matching function to "${parsedTarget.pathPattern}" or update the selector.`,
        scopePaths: createScopePaths(contractPath, matchedFiles, parsedTarget.pathPattern),
      }),
    ];
  }

  const violations: Violation[] = [];

  for (const match of functionMatches) {
    for (const requiredParameter of declaration.mustHaveParameters) {
      if (!match.functionInfo.parameters.includes(requiredParameter)) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: match.filePath,
            line: match.functionInfo.line,
            column: match.functionInfo.column,
            summary: `Function "${match.functionInfo.qualname}" must define parameter "${requiredParameter}".`,
            detail: `Function shape "${declaration.id}" requires parameter "${requiredParameter}".`,
            fixSummary: `Add parameter "${requiredParameter}" to "${match.functionInfo.qualname}" in "${match.filePath}".`,
          }),
        );
      }
    }

    for (const requiredDecorator of declaration.mustHaveDecorators) {
      if (!match.functionInfo.decorators.some((decorator) => matchesNamedReference(decorator, requiredDecorator))) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: match.filePath,
            line: match.functionInfo.line,
            column: match.functionInfo.column,
            summary: `Function "${match.functionInfo.qualname}" must use decorator "${requiredDecorator}".`,
            detail: `Function shape "${declaration.id}" requires decorator "${requiredDecorator}".`,
            fixSummary: `Add decorator "${requiredDecorator}" to "${match.functionInfo.qualname}" in "${match.filePath}".`,
          }),
        );
      }
    }

    for (const requiredCall of declaration.mustHaveCalls) {
      if (!match.functionInfo.calls.some((called) => minimatch(called.name, requiredCall))) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: match.filePath,
            line: match.functionInfo.line,
            column: match.functionInfo.column,
            summary: `Function "${match.functionInfo.qualname}" must call "${requiredCall}".`,
            detail: `Function shape "${declaration.id}" requires a matching call expression.`,
            fixSummary: `Add a call matching "${requiredCall}" inside "${match.functionInfo.qualname}" in "${match.filePath}".`,
          }),
        );
      }
    }
  }

  return violations;
}

function validateFunctionSelector(id: string, target: ParsedTarget): SelectorValidation {
  if (target.selectorName === undefined && target.selectorFilter === undefined) {
    return {
      error: `function-shape "${id}" target must include "::function_name" or "::[fastapi-route]".`,
    };
  }

  if (target.selectorFilter !== undefined && target.selectorFilter !== "fastapi-route") {
    return {
      error: `function-shape "${id}" selector filter "[${target.selectorFilter}]" is not supported.`,
    };
  }

  return {};
}
