import { type ClassShapeDeclaration, type Violation } from "@stele/core";
import {
  collectClassMatches,
  createConfigurationViolation,
  createRuleViolation,
  createScopePaths,
  matchesNamedReference,
  parseTarget,
  type ParsedTarget,
  type PythonFileAnalysis,
  type PythonFunction,
  type SelectorValidation,
} from "./code-shape-common.js";

export function evaluateClassShapeDeclaration(
  declaration: ClassShapeDeclaration,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
  contractPath: string,
  command: string,
): Violation[] {
  const selectorValidation = validateNamedSelector("class-shape", declaration.id, parseTarget(declaration.target));

  if (selectorValidation.error !== undefined) {
    return [createConfigurationViolation(contractPath, declaration.id, selectorValidation.error, command)];
  }

  const parsedTarget = parseTarget(declaration.target);
  const classMatches = collectClassMatches(parsedTarget, matchedFiles, fileAnalyses);

  if (classMatches.length === 0) {
    // Closeout 3a (2026-05-25): when the target selector does not resolve
    // to a class, try the two free-function paths before emitting "not
    // found":
    //   1. Factory mode — the target is a function whose declared return
    //      type is a literal object type; required-method / required-field
    //      lookup checks the return type's members.
    //   2. Module-function mode — the target is a free function; the
    //      lookup uses `aggregate-members` to enumerate sibling exports
    //      that belong to this aggregate (M6 fix — no implicit "all
    //      siblings" enumeration).
    // Otherwise fall back to the original "Target class not found"
    // violation.
    const functionMatches = collectModuleFunctionMatches(parsedTarget, matchedFiles, fileAnalyses);

    if (functionMatches.length === 0) {
      return [
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: matchedFiles[0] ?? parsedTarget.pathPattern,
          summary: `Target "${parsedTarget.selectorName}" was not found as a class, module function, or factory.`,
          detail: `Class shape "${declaration.id}" expects a class, function, or factory selector that resolves inside "${parsedTarget.pathPattern}".`,
          fixSummary: `Define "${parsedTarget.selectorName}" in a file matched by "${parsedTarget.pathPattern}" or update the target selector.`,
          scopePaths: createScopePaths(contractPath, matchedFiles, parsedTarget.pathPattern),
        }),
      ];
    }

    return evaluateFreeFunctionClassShape(declaration, functionMatches, contractPath, command);
  }

  const violations: Violation[] = [];

  for (const match of classMatches) {
    for (const requiredField of declaration.mustHaveFields) {
      const fields = match.classInfo.fields.filter((field) => field.name === requiredField.name);

      if (fields.length === 0) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: match.filePath,
            line: match.classInfo.line,
            column: match.classInfo.column,
            summary: `Class "${match.classInfo.name}" must define field "${requiredField.name}".`,
            detail: `Class shape "${declaration.id}" requires "${requiredField.name}" in "${match.classInfo.name}".`,
            fixSummary: `Add field "${requiredField.name}" to "${match.classInfo.name}" in "${match.filePath}".`,
          }),
        );
        continue;
      }

      if (requiredField.type !== undefined && !fields.some((field) => field.annotation === requiredField.type)) {
        const actualTypes = [...new Set(fields.map((field) => field.annotation).filter((value): value is string => value !== undefined))];
        const anchor = fields[0] ?? match.classInfo;
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: match.filePath,
            line: anchor.line,
            column: anchor.column,
            summary: `Class "${match.classInfo.name}" field "${requiredField.name}" must be annotated as "${requiredField.type}".`,
            detail: actualTypes.length === 0 ? "No type annotation was found for that field." : `Found ${actualTypes.join(", ")} instead.`,
            fixSummary: `Update "${requiredField.name}" in "${match.filePath}" to use annotation "${requiredField.type}".`,
          }),
        );
      }
    }

    for (const requiredMethod of declaration.mustHaveMethods) {
      if (!match.classInfo.methods.some((method) => method.name === requiredMethod)) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: match.filePath,
            line: match.classInfo.line,
            column: match.classInfo.column,
            summary: `Class "${match.classInfo.name}" must define method "${requiredMethod}".`,
            detail: `Class shape "${declaration.id}" requires method "${requiredMethod}".`,
            fixSummary: `Add method "${requiredMethod}" to "${match.classInfo.name}" in "${match.filePath}".`,
          }),
        );
      }
    }

    for (const requiredBase of declaration.mustExtend) {
      if (!match.classInfo.bases.some((base) => matchesNamedReference(base, requiredBase))) {
        violations.push(
          createRuleViolation({
            declaration,
            command,
            contractPath,
            filePath: match.filePath,
            line: match.classInfo.line,
            column: match.classInfo.column,
            summary: `Class "${match.classInfo.name}" must extend "${requiredBase}".`,
            detail: `Class shape "${declaration.id}" requires base "${requiredBase}".`,
            fixSummary: `Update "${match.classInfo.name}" in "${match.filePath}" to inherit from "${requiredBase}".`,
          }),
        );
      }
    }
  }

  return violations;
}

function validateNamedSelector(kind: string, id: string, target: ParsedTarget): SelectorValidation {
  if (target.selectorName === undefined || target.selectorName.length === 0) {
    return {
      error: `${kind} "${id}" target must include a named selector after "::".`,
    };
  }

  if (target.selectorFilter !== undefined) {
    return {
      error: `${kind} "${id}" does not support selector filter "[${target.selectorFilter}]".`,
    };
  }

  return {};
}

type ModuleFunctionMatch = {
  filePath: string;
  functionInfo: PythonFunction;
  fileAnalysis: PythonFileAnalysis;
};

/**
 * Closeout 3a (2026-05-25): resolve `target.selectorName` to a top-level
 * function declaration (function or arrow-function variable) inside one
 * of the matched files. Used by the class-shape evaluator's free-function
 * dispatch path. Only matches when `functionInfo.qualname === name`
 * (top-level scope) — nested functions or class methods are excluded
 * because the file's `analysis.functions` already qualifies them as
 * `Class.method`.
 */
function collectModuleFunctionMatches(
  target: ParsedTarget,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): ModuleFunctionMatch[] {
  const matches: ModuleFunctionMatch[] = [];

  for (const filePath of matchedFiles) {
    const analysis = fileAnalyses.get(filePath);

    if (analysis === undefined) {
      continue;
    }

    for (const functionInfo of analysis.functions) {
      // Top-level only: `name === qualname` distinguishes a module-level
      // function from a class method (whose qualname is `Class.method`).
      if (functionInfo.name === target.selectorName && functionInfo.qualname === target.selectorName) {
        matches.push({ filePath, functionInfo, fileAnalysis: analysis });
      }
    }
  }

  return matches;
}

/**
 * Closeout 3a (2026-05-25): evaluate a class-shape declaration whose
 * target resolved to a free function (module function or factory).
 *
 * Dispatch order per function match:
 *   1. If `aggregateMembers` is declared, run module-function mode so
 *      aggregate-root contracts stay scoped to sibling exports.
 *   2. Otherwise, if the function declares a literal-object or same-file
 *      alias return type, run factory mode: required-method /
 *      required-field lookup checks the `returnTypeMembers` set.
 *   3. Otherwise run module-function mode: required-method /
 *      required-field lookup checks the names enumerated by the
 *      class-shape's `aggregateMembers`, plus the target's own name.
 *
 * In module-function mode, when `aggregateMembers` is empty the only
 * required-method allowed is the target's own name. Any other required-
 * method emits an "aggregate-members missing" violation — preventing the
 * silently-vacuous case where `(must-have-method "foo")` would match
 * nothing because the aggregate hasn't enumerated `foo` as a member.
 */
function evaluateFreeFunctionClassShape(
  declaration: ClassShapeDeclaration,
  matches: ModuleFunctionMatch[],
  contractPath: string,
  command: string,
): Violation[] {
  const violations: Violation[] = [];

  for (const match of matches) {
    const isFactory = declaration.aggregateMembers.length === 0 &&
      (match.functionInfo.returnTypeMembers?.length ?? 0) > 0;
    if (isFactory) {
      violations.push(...evaluateFactoryShape(declaration, match, contractPath, command));
    } else {
      violations.push(...evaluateModuleFunctionShape(declaration, match, contractPath, command));
    }
  }

  // `mustExtend` has no semantics for free functions — emit a configuration
  // violation if a contract author tries to use it.
  if (declaration.mustExtend.length > 0) {
    violations.push(
      createConfigurationViolation(
        contractPath,
        declaration.id,
        `class-shape "${declaration.id}" targets a free function but declares (must-extend …); free-function targets do not support inheritance constraints.`,
        command,
      ),
    );
  }

  return violations;
}

function evaluateFactoryShape(
  declaration: ClassShapeDeclaration,
  match: ModuleFunctionMatch,
  contractPath: string,
  command: string,
): Violation[] {
  const violations: Violation[] = [];
  const memberSet = new Set(match.functionInfo.returnTypeMembers ?? []);

  for (const requiredMethod of declaration.mustHaveMethods) {
    if (!memberSet.has(requiredMethod)) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: match.filePath,
          line: match.functionInfo.line,
          column: match.functionInfo.column,
          summary: `Factory "${match.functionInfo.name}" return type must declare member "${requiredMethod}".`,
          detail: `Class shape "${declaration.id}" requires method "${requiredMethod}" on the object returned by factory "${match.functionInfo.name}".`,
          fixSummary: `Add member "${requiredMethod}" to the literal return type of "${match.functionInfo.name}" in "${match.filePath}" — or remove (must-have-method "${requiredMethod}") if it is not part of this aggregate's contract.`,
        }),
      );
    }
  }

  for (const requiredField of declaration.mustHaveFields) {
    if (!memberSet.has(requiredField.name)) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: match.filePath,
          line: match.functionInfo.line,
          column: match.functionInfo.column,
          summary: `Factory "${match.functionInfo.name}" return type must declare field "${requiredField.name}".`,
          detail: `Class shape "${declaration.id}" requires field "${requiredField.name}" on the object returned by factory "${match.functionInfo.name}".`,
          fixSummary: `Add field "${requiredField.name}" to the literal return type of "${match.functionInfo.name}" in "${match.filePath}".`,
        }),
      );
    }
  }

  return violations;
}

function evaluateModuleFunctionShape(
  declaration: ClassShapeDeclaration,
  match: ModuleFunctionMatch,
  contractPath: string,
  command: string,
): Violation[] {
  const violations: Violation[] = [];
  const targetName = match.functionInfo.name;
  const memberSet = new Set<string>([targetName, ...declaration.aggregateMembers]);
  const moduleVariableSet = new Set<string>(match.fileAnalysis.moduleVariables ?? []);
  const moduleFunctionNames = new Set<string>(match.fileAnalysis.functions.map((f) => f.name));

  // Sanity check: every (aggregate-members "x") must correspond to a real
  // module-level export. Mismatch is a contract-authoring error — surface
  // it loudly so the author cannot silently rename a sibling out from
  // under the aggregate.
  for (const member of declaration.aggregateMembers) {
    if (!moduleVariableSet.has(member)) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: match.filePath,
          line: match.functionInfo.line,
          column: match.functionInfo.column,
          summary: `Aggregate-member "${member}" was not found at module level in "${match.filePath}".`,
          detail: `Class shape "${declaration.id}" enumerates "${member}" in (aggregate-members …) but no top-level declaration of that name exists in the target file.`,
          fixSummary: `Either rename "${member}" to a real top-level export in "${match.filePath}" or remove it from the aggregate's aggregate_members list.`,
        }),
      );
    }
  }

  // Required-method check: look for the name in the file's top-level
  // functions, but scope the lookup to `memberSet` so two aggregates
  // targeting the same module cannot cross-bind on each other's siblings.
  for (const requiredMethod of declaration.mustHaveMethods) {
    if (!memberSet.has(requiredMethod)) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: match.filePath,
          line: match.functionInfo.line,
          column: match.functionInfo.column,
          summary: `Aggregate "${targetName}" required method "${requiredMethod}" is outside its aggregate-members enumeration.`,
          detail: `Class shape "${declaration.id}" declares (must-have-method "${requiredMethod}") but "${requiredMethod}" is neither the target name nor listed in (aggregate-members …).`,
          fixSummary: `Either add "${requiredMethod}" to (aggregate-members …) for class-shape "${declaration.id}" or drop the requirement.`,
        }),
      );
      continue;
    }

    if (!moduleFunctionNames.has(requiredMethod)) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: match.filePath,
          line: match.functionInfo.line,
          column: match.functionInfo.column,
          summary: `Aggregate "${targetName}" must define module function "${requiredMethod}".`,
          detail: `Class shape "${declaration.id}" requires method "${requiredMethod}" as a top-level function in "${match.filePath}".`,
          fixSummary: `Add a top-level function named "${requiredMethod}" to "${match.filePath}".`,
        }),
      );
    }
  }

  // Required-field check: a "field" on a free-function aggregate is a
  // top-level const/let/var export (e.g. a sentinel value or a registry
  // singleton). The aggregate-members enumeration scopes the lookup
  // identically to the required-method case.
  for (const requiredField of declaration.mustHaveFields) {
    if (!memberSet.has(requiredField.name)) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: match.filePath,
          line: match.functionInfo.line,
          column: match.functionInfo.column,
          summary: `Aggregate "${targetName}" required field "${requiredField.name}" is outside its aggregate-members enumeration.`,
          detail: `Class shape "${declaration.id}" declares (must-have-field "${requiredField.name}") but "${requiredField.name}" is neither the target name nor listed in (aggregate-members …).`,
          fixSummary: `Either add "${requiredField.name}" to (aggregate-members …) for class-shape "${declaration.id}" or drop the requirement.`,
        }),
      );
      continue;
    }

    if (!moduleVariableSet.has(requiredField.name)) {
      violations.push(
        createRuleViolation({
          declaration,
          command,
          contractPath,
          filePath: match.filePath,
          line: match.functionInfo.line,
          column: match.functionInfo.column,
          summary: `Aggregate "${targetName}" must define module variable "${requiredField.name}".`,
          detail: `Class shape "${declaration.id}" requires field "${requiredField.name}" as a top-level const/let/var in "${match.filePath}".`,
          fixSummary: `Add a top-level declaration named "${requiredField.name}" to "${match.filePath}".`,
        }),
      );
    }
  }

  return violations;
}
