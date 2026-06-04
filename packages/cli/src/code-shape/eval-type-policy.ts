import { type TypePolicyDeclaration, type Violation } from "@stele/core";
import {
  collectClassMatches,
  collectFunctionMatches,
  createRuleViolation,
  createScopePaths,
  parseTarget,
  type ParsedTarget,
  type PythonAnnotation,
  type PythonFileAnalysis,
  type TypeDeclarationAnalysis,
  type TypeFieldAnalysis,
} from "./code-shape-common.js";

export function evaluateTypePolicyDeclaration(
  declaration: TypePolicyDeclaration,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
  contractPath: string,
  command: string,
): Violation[] {
  const parsedTarget = parseTarget(declaration.target);
  const annotations = collectAnnotationsForTarget(parsedTarget, matchedFiles, fileAnalyses);
  const violations: Violation[] = [];

  for (const deniedType of declaration.denyTypes) {
    for (const annotation of annotations) {
      if (!annotationUsesType(annotation.annotation, deniedType)) {
        continue;
      }

      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: annotation.filePath,
          line: annotation.annotation.line,
          column: annotation.annotation.column,
          summary: `Annotation "${annotation.annotation.text}" uses denied type "${deniedType}".`,
          detail: `Type policy "${declaration.id}" forbids "${deniedType}" in the matched scope.`,
          fixSummary: `Replace "${deniedType}" in "${annotation.filePath}" or narrow the type-policy target.`,
        }),
      );
    }
  }

  for (const requiredType of declaration.requireTypes) {
    if (annotations.some((annotation) => annotationUsesType(annotation.annotation, requiredType))) {
      continue;
    }

    violations.push(
      createRuleViolation({
        declaration,
        command,
        contractPath,
        filePath: matchedFiles[0] ?? parsedTarget.pathPattern,
        summary: `Type policy "${declaration.id}" requires annotation "${requiredType}" in the matched scope.`,
        detail: `No annotation matching "${requiredType}" was found.`,
        fixSummary: `Add an annotation using "${requiredType}" within files matched by "${parsedTarget.pathPattern}".`,
        scopePaths: createScopePaths(contractPath, matchedFiles, parsedTarget.pathPattern),
      }),
    );
  }

  // Zero-binding guard: when a type-policy declares requireFieldTypes but NO
  // type/interface in scope matches the owner-suffix policy, the requirement
  // loop below never runs and the policy passes silently — a green check that
  // protects nothing (e.g. every `*Violation`/`*Report` owner was renamed
  // away). Surface it as an error instead, mirroring the other code-shape
  // mechanisms' 0-match guards.
  if (declaration.requireFieldTypes.length > 0) {
    const matchedOwners = collectTypeDeclarationsForTarget(parsedTarget, matchedFiles, fileAnalyses).filter(
      (typeDeclaration) => ownerMatchesSuffixPolicy(typeDeclaration.name, declaration.ownerNameSuffixes),
    );
    if (matchedOwners.length === 0) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: matchedFiles[0] ?? parsedTarget.pathPattern,
          summary: `Type policy "${declaration.id}" matched no owner types — it enforces nothing.`,
          detail: `requireFieldTypes is declared but no type/interface in "${parsedTarget.pathPattern}" matched the owner-name suffix policy [${declaration.ownerNameSuffixes.join(", ")}]. A green check that protects nothing is not allowed.`,
          fixSummary: `Fix the target/owner-suffix so it resolves to real types, or remove the requireFieldTypes requirement if those owners legitimately no longer exist.`,
          scopePaths: createScopePaths(contractPath, matchedFiles, parsedTarget.pathPattern),
        }),
      );
    }
  }

  for (const requirement of declaration.requireFieldTypes) {
    for (const typeDeclaration of collectTypeDeclarationsForTarget(parsedTarget, matchedFiles, fileAnalyses)) {
      if (!ownerMatchesSuffixPolicy(typeDeclaration.name, declaration.ownerNameSuffixes)) {
        continue;
      }

      const field = typeDeclaration.fields.find((candidate) => candidate.name === requirement.fieldName);
      if (field === undefined) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: typeDeclaration.filePath,
            line: typeDeclaration.line,
            column: typeDeclaration.column,
            summary: `Type "${typeDeclaration.name}" must declare field "${requirement.fieldName}".`,
            detail: `Type policy "${declaration.id}" requires "${requirement.fieldName}: ${requirement.typeName}" on matching type/interface declarations.`,
            fixSummary: `Add field "${requirement.fieldName}: ${requirement.typeName}" to "${typeDeclaration.name}".`,
          }),
        );
        continue;
      }

      if (!fieldMatchesRequiredFieldType(field, requirement.typeName)) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: typeDeclaration.filePath,
            line: field.line,
            column: field.column,
            summary: `Field "${typeDeclaration.name}.${field.name}" must use type "${requirement.typeName}".`,
            detail: `Type policy "${declaration.id}" found "${field.annotation ?? "<missing>"}" instead.`,
            fixSummary: `Change "${typeDeclaration.name}.${field.name}" to use "${requirement.typeName}".`,
          }),
        );
      }
    }
  }

  return violations;
}

function collectAnnotationsForTarget(
  target: ParsedTarget,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): Array<{ filePath: string; annotation: PythonAnnotation }> {
  if (target.selectorName === undefined && target.selectorFilter === undefined) {
    return matchedFiles.flatMap((filePath) =>
      (fileAnalyses.get(filePath)?.annotations ?? []).map((annotation) => ({ filePath, annotation })),
    );
  }

  const functionMatches = collectFunctionMatches(target, matchedFiles, fileAnalyses);

  if (functionMatches.length > 0) {
    return functionMatches.flatMap((match) =>
      match.functionInfo.annotations.map((annotation) => ({
        filePath: match.filePath,
        annotation,
      })),
    );
  }

  const classMatches = collectClassMatches(target, matchedFiles, fileAnalyses);

  return classMatches.flatMap((match) =>
    match.classInfo.annotations.map((annotation) => ({
      filePath: match.filePath,
      annotation,
    })),
  );
}

function fieldMatchesRequiredFieldType(field: TypeFieldAnalysis, requiredType: string): boolean {
  if (field.optional) {
    return false;
  }
  if (!field.annotationNames.includes(requiredType)) {
    return false;
  }

  return !field.annotationNames.some((name) => name === "any" || name === "string");
}

function collectTypeDeclarationsForTarget(
  target: ParsedTarget,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): Array<TypeDeclarationAnalysis & { filePath: string }> {
  const declarations: Array<TypeDeclarationAnalysis & { filePath: string }> = [];

  for (const filePath of matchedFiles) {
    for (const declaration of fileAnalyses.get(filePath)?.typeDeclarations ?? []) {
      if (target.selectorName !== undefined && declaration.name !== target.selectorName) {
        continue;
      }
      declarations.push({ ...declaration, filePath });
    }
  }

  return declarations;
}

function ownerMatchesSuffixPolicy(ownerName: string, suffixes: readonly string[]): boolean {
  return suffixes.length === 0 || suffixes.some((suffix) => ownerName.endsWith(suffix));
}

function annotationUsesType(annotation: PythonAnnotation, expectedType: string): boolean {
  return (
    annotation.text === expectedType ||
    annotation.names.some((name) => name === expectedType || name.endsWith(`.${expectedType}`))
  );
}
