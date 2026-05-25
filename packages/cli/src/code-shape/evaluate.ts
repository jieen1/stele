import { MAX_CHILD_PROCESS_BUFFER } from "../config/defaults.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import globParent from "glob-parent";
import { minimatch } from "minimatch";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolvePythonRuntime as resolvePythonRuntimeUncached } from "../utils/shared-utils.js";
import {
  contractPath,
  createViolation,
  ruleId,
  type BoundaryDeclaration,
  type ClassShapeDeclaration,
  type CodeShapeDeclaration,
  type Contract,
  type FilePolicyDeclaration,
  type FunctionShapeDeclaration,
  type TypePolicyDeclaration,
  type Violation,
} from "@stele/core";
import { stableStringCompare, uniqueSortedStrings } from "@stele/core";
import { analyzeTypeScriptFiles, isTypeScriptFilePath } from "./typescript-analyzer.js";

const execFileAsync = promisify(execFile);

type PythonAnalysisResult = {
  files: PythonFileAnalysis[];
  errors: PythonAnalysisError[];
};

type PythonAnalysisError = {
  path: string;
  summary: string;
  detail?: string;
  line?: number;
  column?: number;
};

type PythonImport = {
  candidates: string[];
  line: number;
  column: number;
};

type PythonCall = {
  name: string;
  line: number;
  column: number;
};

type PythonAnnotation = {
  text: string;
  names: string[];
  line: number;
  column: number;
};

type PythonField = {
  name: string;
  annotation?: string;
  line: number;
  column: number;
};

type PythonMethod = {
  name: string;
  line: number;
  column: number;
  decorators: string[];
  parameters: string[];
  calls: PythonCall[];
  annotations: PythonAnnotation[];
  fastapiRoute: boolean;
};

type PythonClass = {
  name: string;
  line: number;
  column: number;
  bases: string[];
  fields: PythonField[];
  methods: PythonMethod[];
  annotations: PythonAnnotation[];
};

type PythonFunction = {
  name: string;
  qualname: string;
  line: number;
  column: number;
  decorators: string[];
  parameters: string[];
  calls: PythonCall[];
  annotations: PythonAnnotation[];
  fastapiRoute: boolean;
  // Closeout 3a (2026-05-25): populated by the TS analyzer only when the
  // function's declared return type is a literal object type. Always
  // undefined for Python-analyzed files; the class-shape evaluator's
  // factory-mode dispatch is TS-only.
  returnTypeMembers?: string[];
};

type PythonFileAnalysis = {
  path: string;
  imports: PythonImport[];
  calls: PythonCall[];
  annotations: PythonAnnotation[];
  classes: PythonClass[];
  functions: PythonFunction[];
  // Closeout 3a (2026-05-25): populated by the TS analyzer; empty for
  // Python-analyzed files. The class-shape evaluator's module-function
  // mode uses this to enumerate sibling exports referenced by
  // `aggregate-members`.
  moduleVariables?: string[];
};

type ParsedTarget = {
  pathPattern: string;
  selectorName?: string;
  selectorFilter?: string;
};

type PythonRuntime = {
  command: string;
  args: string[];
};

type SelectorValidation = {
  error?: string;
};

let cachedPythonRuntime: Promise<PythonRuntime | undefined> | undefined;

export async function evaluateCodeShapes(projectDir: string, contract: Contract, command = "check"): Promise<Violation[]> {
  if (contract.codeShapes.length === 0) {
    return [];
  }

  const relativeContractPaths = new Map(
    contract.files.map((file) => [file.path, toProjectRelativePath(projectDir, file.path)] as const),
  );
  const targetMap = new Map<string, string[]>();
  const targetErrorIds = new Set<string>();
  const pythonFiles = new Set<string>();
  // Round 14 P1: typescript files matched + queued for the in-process
  // ts.createSourceFile analyzer.
  const typescriptFiles = new Set<string>();
  const violations: Violation[] = [];

  for (const declaration of contract.codeShapes) {
    const parsedTarget = parseTarget(declaration.target);
    const contractPath = relativeContractPaths.get(declaration.filePath) ?? declaration.filePath;
    const targetError = validateTargetPathPattern(projectDir, parsedTarget.pathPattern);

    if (targetError !== undefined) {
      targetErrorIds.add(declaration.id);
      targetMap.set(declaration.id, []);
      violations.push(createConfigurationViolation(contractPath, declaration.id, targetError, command));
      continue;
    }

    // Round 14 P1: dispatch the file-matching filter on the
    // declaration's `lang`. A python declaration only matches .py;
    // a typescript declaration only matches .ts/.tsx.
    const expanded = await expandTargetPattern(projectDir, parsedTarget.pathPattern);
    const langFilter = declaration.lang === "typescript" ? isTypeScriptFilePath : isPythonFilePath;
    const matchedFiles = expanded.filter(langFilter);
    targetMap.set(declaration.id, matchedFiles);

    if (requiresSourceAnalysis(declaration)) {
      const targetSet = declaration.lang === "typescript" ? typescriptFiles : pythonFiles;
      for (const filePath of matchedFiles) {
        targetSet.add(filePath);
      }
    }
  }

  const analysis = await analyzePythonFiles(projectDir, [...pythonFiles], command, relativeContractPaths);
  // Round 14 P1: merge TypeScript analyzer results into the same
  // fileAnalyses map so downstream evaluators consume both
  // languages uniformly.
  const tsAnalysis = await analyzeTypeScriptFiles(projectDir, [...typescriptFiles]);
  const fileAnalyses = new Map<string, PythonFileAnalysis>(
    analysis.files.map((file) => [file.path, file] as const),
  );
  for (const tsFile of tsAnalysis.files) {
    fileAnalyses.set(tsFile.path, tsFile as unknown as PythonFileAnalysis);
  }
  violations.push(...analysis.errors.map((error) => createExecutionErrorViolation(projectDir, error, command)));
  for (const error of tsAnalysis.errors) {
    violations.push(createExecutionErrorViolation(projectDir, error, command));
  }

  for (const declaration of contract.codeShapes) {
    if (targetErrorIds.has(declaration.id)) {
      continue;
    }

    const contractPath = relativeContractPaths.get(declaration.filePath) ?? declaration.filePath;
    const matchedFiles = targetMap.get(declaration.id) ?? [];

    switch (declaration.kind) {
      case "boundary":
        violations.push(...evaluateBoundaryDeclaration(declaration, matchedFiles, fileAnalyses, contractPath, command));
        break;
      case "class-shape":
        violations.push(...evaluateClassShapeDeclaration(declaration, matchedFiles, fileAnalyses, contractPath, command));
        break;
      case "function-shape":
        violations.push(...evaluateFunctionShapeDeclaration(declaration, matchedFiles, fileAnalyses, contractPath, command));
        break;
      case "type-policy":
        violations.push(...evaluateTypePolicyDeclaration(declaration, matchedFiles, fileAnalyses, contractPath, command));
        break;
      case "file-policy":
        violations.push(...(await evaluateFilePolicyDeclaration(projectDir, declaration, matchedFiles, contractPath, command)));
        break;
    }
  }

  return violations;
}

function requiresSourceAnalysis(declaration: CodeShapeDeclaration): boolean {
  // file-policy only inspects file contents on disk; it doesn't need
  // an AST analyzer for either language.
  return declaration.kind !== "file-policy";
}

async function analyzePythonFiles(
  projectDir: string,
  files: string[],
  command: string,
  relativeContractPaths: Map<string, string>,
): Promise<PythonAnalysisResult> {
  if (files.length === 0) {
    return { files: [], errors: [] };
  }

  const runtime = await resolvePythonRuntime();

  if (runtime === undefined) {
    return {
      files: [],
      errors: [
        {
          path: [...relativeContractPaths.values()][0] ?? contractPath("contract/main.stele"),
          summary: "Python 3 is required to evaluate Python code-shape rules.",
          detail: 'Install Python 3 and make sure "python", "py -3", or "python3" is available on PATH.',
        },
      ],
    };
  }

  const workspaceDir = await mkdtemp(resolve(tmpdir(), "stele-code-shape-"));
  const payloadPath = resolve(workspaceDir, "payload.json");
  const scriptPath = resolve(workspaceDir, "analyze.py");

  try {
    await writeFile(
      payloadPath,
      JSON.stringify({
        files: files.map((file) => ({
          absolute_path: resolve(projectDir, file),
          relative_path: file,
        })),
      }),
      "utf8",
    );
    await writeFile(scriptPath, PYTHON_ANALYZER_SCRIPT, "utf8");

    const { stdout } = await execFileAsync(runtime.command, [...runtime.args, scriptPath, payloadPath], {
      cwd: projectDir,
      windowsHide: true,
      maxBuffer: MAX_CHILD_PROCESS_BUFFER,
    });

    return JSON.parse(stdout) as PythonAnalysisResult;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return {
      files: [],
      errors: [
        {
          path: [...relativeContractPaths.values()][0] ?? contractPath("contract/main.stele"),
          summary: "Python code-shape analysis could not be completed.",
          detail: sanitizePythonExecutionDetail(detail, command),
        },
      ],
    };
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function resolvePythonRuntime(): Promise<PythonRuntime | undefined> {
  cachedPythonRuntime ??= resolvePythonRuntimeUncached();
  return cachedPythonRuntime;
}

function evaluateBoundaryDeclaration(
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

function evaluateClassShapeDeclaration(
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

function evaluateFunctionShapeDeclaration(
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

function evaluateTypePolicyDeclaration(
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

  return violations;
}

async function evaluateFilePolicyDeclaration(
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

function createRuleViolation(options: {
  declaration: CodeShapeDeclaration;
  command: string;
  contractPath: string;
  filePath: string;
  summary: string;
  detail: string;
  fixSummary: string;
  line?: number;
  column?: number;
  scopePaths?: string[];
}): Violation {
  return createViolation({
    rule_id: ruleId(options.declaration.id),
    rule_kind: "rule_violation",
    severity: "error",
    source: {
      tool: "stele",
      command: options.command,
      kind: "rule",
    },
    location: {
      path: options.filePath,
      line: options.line,
      column: options.column,
    },
    cause: {
      summary: options.summary,
      detail: options.detail,
    },
    scope_paths: options.scopePaths ?? uniqueSortedStrings([options.filePath, options.contractPath]),
    fix: {
      summary: options.fixSummary,
    },
  });
}

function createExecutionErrorViolation(projectDir: string, error: PythonAnalysisError, command: string): Violation {
  return createViolation({
    rule_id: ruleId("stele.check.execution_error"),
    rule_kind: "execution_error",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "execution",
    },
    location: {
      path: normalizePath(error.path, projectDir),
      line: error.line,
      column: error.column,
    },
    cause: {
      summary: error.summary,
      detail: error.detail,
    },
    scope_paths: [normalizePath(error.path, projectDir)],
    fix: {
      summary: "Fix the Python analysis error and re-run stele check.",
    },
  });
}

function createConfigurationViolation(contractPath: string, declarationId: string, summary: string, command: string): Violation {
  return createViolation({
    rule_id: ruleId("stele.check.execution_error"),
    rule_kind: "execution_error",
    severity: "error",
    source: {
      tool: "stele",
      command,
      kind: "execution",
    },
    location: {
      path: contractPath,
    },
    cause: {
      summary,
    },
    scope_paths: [contractPath],
    fix: {
      summary: `Update code-shape "${declarationId}" so its target selector is valid.`,
    },
  });
}

function parseTarget(target: string): ParsedTarget {
  const separatorIndex = target.indexOf("::");

  if (separatorIndex === -1) {
    return {
      pathPattern: normalizeRelativePath(target),
    };
  }

  const pathPattern = normalizeRelativePath(target.slice(0, separatorIndex));
  const selector = target.slice(separatorIndex + 2).trim();

  if (selector.startsWith("[") && selector.endsWith("]")) {
    return {
      pathPattern,
      selectorFilter: selector.slice(1, -1),
    };
  }

  const filterIndex = selector.indexOf("[");

  if (filterIndex !== -1 && selector.endsWith("]")) {
    return {
      pathPattern,
      selectorName: selector.slice(0, filterIndex),
      selectorFilter: selector.slice(filterIndex + 1, -1),
    };
  }

  return {
    pathPattern,
    selectorName: selector,
  };
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

function collectClassMatches(
  target: ParsedTarget,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): Array<{ filePath: string; classInfo: PythonClass }> {
  const matches: Array<{ filePath: string; classInfo: PythonClass }> = [];

  for (const filePath of matchedFiles) {
    const analysis = fileAnalyses.get(filePath);

    if (analysis === undefined) {
      continue;
    }

    for (const classInfo of analysis.classes) {
      if (classInfo.name === target.selectorName) {
        matches.push({ filePath, classInfo });
      }
    }
  }

  return matches;
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
 *   1. If the function declares a literal-object return type, run
 *      factory mode: required-method / required-field lookup checks the
 *      `returnTypeMembers` set.
 *   2. Otherwise run module-function mode: required-method /
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
    const isFactory = (match.functionInfo.returnTypeMembers?.length ?? 0) > 0;
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

function collectFunctionMatches(
  target: ParsedTarget,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): Array<{ filePath: string; functionInfo: PythonFunction }> {
  const matches: Array<{ filePath: string; functionInfo: PythonFunction }> = [];

  for (const filePath of matchedFiles) {
    const analysis = fileAnalyses.get(filePath);

    if (analysis === undefined) {
      continue;
    }

    for (const functionInfo of analysis.functions) {
      if (target.selectorName !== undefined && functionInfo.name !== target.selectorName && functionInfo.qualname !== target.selectorName) {
        continue;
      }

      if (target.selectorFilter === "fastapi-route" && !functionInfo.fastapiRoute) {
        continue;
      }

      matches.push({ filePath, functionInfo });
    }
  }

  return matches;
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

async function expandTargetPattern(projectDir: string, pattern: string): Promise<string[]> {
  const normalizedPattern = normalizeRelativePath(pattern);
  const rootPattern = normalizeRelativePath(globParent(normalizedPattern));
  const rootDirectory = rootPattern === "." ? resolve(projectDir) : resolve(projectDir, rootPattern);
  const files = await walkRoot(rootDirectory, resolve(projectDir));

  return files.filter((file) => minimatch(file, normalizedPattern));
}

async function walkRoot(directory: string, projectDir: string): Promise<string[]> {
  try {
    const directoryStat = await stat(directory);

    if (!directoryStat.isDirectory()) {
      const relativePath = normalizeRelativePath(relative(projectDir, directory));
      return relativePath.startsWith("../") ? [] : [relativePath];
    }
  } catch {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      // Skip symlinks to directories — prevents traversal outside project via symlink
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        continue;
      }
      files.push(...(await walkRoot(absolutePath, projectDir)));
      continue;
    }

    if (entry.isFile()) {
      const relativePath = normalizeRelativePath(relative(projectDir, absolutePath));

      if (!relativePath.startsWith("../")) {
        files.push(relativePath);
      }
    }
  }

  return files.sort((left, right) => stableStringCompare(left, right));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function validateTargetPathPattern(projectDir: string, pathPattern: string): string | undefined {
  const normalizedPattern = normalizeRelativePath(pathPattern);

  if (isAbsolute(normalizedPattern)) {
    return `Code-shape target "${normalizedPattern}" must stay within the project root and cannot be absolute.`;
  }

  const rootPattern = normalizeRelativePath(globParent(normalizedPattern));
  const rootDirectory = rootPattern === "." ? resolve(projectDir) : resolve(projectDir, rootPattern);

  if (!isWithinProjectRoot(projectDir, rootDirectory)) {
    return `Code-shape target "${normalizedPattern}" must stay within the project root.`;
  }

  return undefined;
}

function isPythonFilePath(path: string): boolean {
  return normalizeRelativePath(path).endsWith(".py");
}

function isWithinProjectRoot(projectDir: string, candidatePath: string): boolean {
  const relativePath = normalizeRelativePath(relative(resolve(projectDir), resolve(candidatePath)));

  return relativePath === "." || (relativePath !== ".." && !relativePath.startsWith("../") && !isAbsolute(relativePath));
}

function normalizePath(path: string, projectDir: string): string {
  return path.includes(":") || path.startsWith("/") ? toProjectRelativePath(projectDir, path) : normalizeRelativePath(path);
}

function toProjectRelativePath(projectDir: string, path: string): string {
  const relativePath = normalizeRelativePath(relative(resolve(projectDir), resolve(path)));
  return relativePath.length === 0 ? "." : relativePath;
}

function matchesImportPattern(candidate: string, deniedImport: string): boolean {
  return candidate === deniedImport || candidate.startsWith(`${deniedImport}.`);
}

function matchesNamedReference(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`.${expected}`);
}

function annotationUsesType(annotation: PythonAnnotation, expectedType: string): boolean {
  return (
    annotation.text === expectedType ||
    annotation.names.some((name) => name === expectedType || name.endsWith(`.${expectedType}`))
  );
}

function matchesPathPattern(path: string, pattern: string): boolean {
  return minimatch(path, normalizeRelativePath(pattern));
}

function createScopePaths(contractPath: string, matchedFiles: string[], fallbackPath: string): string[] {
  return uniqueSortedStrings([contractPath, ...(matchedFiles.length === 0 ? [fallbackPath] : matchedFiles)]);
}



function computeFileEndingLocation(content: string): { line: number; column: number } {
  const lines = content.split("\n");
  const line = Math.max(lines.length, 1);
  const column = (lines.at(-1) ?? "").length + 1;
  return { line, column };
}

function sanitizePythonExecutionDetail(detail: string, command: string): string {
  let sanitized = detail
    .replace(/\s+/g, " ")
    .trim();
  sanitized = sanitized
    .replace(/File "[^"]*"/g, 'File "[redacted]"')
    .replace(/File '[^']*'/g, "File '[redacted]'")
    .replaceAll(command, "stele check");
  return sanitized;
}

const PYTHON_ANALYZER_SCRIPT = [
  "import ast",
  "import json",
  "import sys",
  "from pathlib import Path",
  "",
  "FASTAPI_ROUTE_VERBS = {",
  "    'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace', 'websocket'",
  "}",
  "",
  "def expr_name(node):",
  "    if isinstance(node, ast.Name):",
  "        return node.id",
  "    if isinstance(node, ast.Attribute):",
  "        base = expr_name(node.value)",
  "        return f'{base}.{node.attr}' if base else node.attr",
  "    if isinstance(node, ast.Call):",
  "        return expr_name(node.func)",
  "    try:",
  "        return ast.unparse(node)",
  "    except Exception:",
  "        return ''",
  "",
  "def collect_annotation_names(node):",
  "    names = set()",
  "    for child in ast.walk(node):",
  "        if isinstance(child, ast.Name):",
  "            names.add(child.id)",
  "        elif isinstance(child, ast.Attribute):",
  "            names.add(expr_name(child))",
  "    return sorted(names)",
  "",
  "def annotation_record(node):",
  "    return {",
  "        'text': ast.unparse(node),",
  "        'names': collect_annotation_names(node),",
  "        'line': getattr(node, 'lineno', 1),",
  "        'column': getattr(node, 'col_offset', 0) + 1,",
  "    }",
  "",
  "def iter_non_nested(node):",
  "    stack = list(ast.iter_child_nodes(node))",
  "    while stack:",
  "        current = stack.pop()",
  "        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):",
  "            continue",
  "        yield current",
  "        stack.extend(ast.iter_child_nodes(current))",
  "",
  "def collect_calls(node):",
  "    calls = []",
  "    for current in iter_non_nested(node):",
  "        if isinstance(current, ast.Call):",
  "            name = expr_name(current.func)",
  "            if name:",
  "                calls.append({",
  "                    'name': name,",
  "                    'line': getattr(current, 'lineno', 1),",
  "                    'column': getattr(current, 'col_offset', 0) + 1,",
  "                })",
  "    return calls",
  "",
  "def collect_annotations(node):",
  "    annotations = []",
  "    for current in iter_non_nested(node):",
  "        if isinstance(current, ast.AnnAssign):",
  "            annotations.append(annotation_record(current.annotation))",
  "        elif isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):",
  "            for annotation in function_annotations(current):",
  "                annotations.append(annotation)",
  "    return annotations",
  "",
  "def function_annotations(node):",
  "    annotations = []",
  "    args = list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs)",
  "    if node.args.vararg and node.args.vararg.annotation is not None:",
  "        annotations.append(annotation_record(node.args.vararg.annotation))",
  "    if node.args.kwarg and node.args.kwarg.annotation is not None:",
  "        annotations.append(annotation_record(node.args.kwarg.annotation))",
  "    for arg in args:",
  "        if arg.annotation is not None:",
  "            annotations.append(annotation_record(arg.annotation))",
  "    if node.returns is not None:",
  "        annotations.append(annotation_record(node.returns))",
  "    return annotations",
  "",
  "def collect_parameters(node):",
  "    parameters = []",
  "    for arg in list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs):",
  "        parameters.append(arg.arg)",
  "    if node.args.vararg is not None:",
  "        parameters.append(node.args.vararg.arg)",
  "    if node.args.kwarg is not None:",
  "        parameters.append(node.args.kwarg.arg)",
  "    return parameters",
  "",
  "def is_fastapi_route(decorator_names):",
  "    for name in decorator_names:",
  "        lowered = name.lower()",
  "        for verb in FASTAPI_ROUTE_VERBS:",
  "            if lowered == verb or lowered.endswith(f'.{verb}'):",
  "                return True",
  "    return False",
  "",
  "def self_field_from_target(target):",
  "    if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == 'self':",
  "        return target.attr",
  "    return None",
  "",
  "def class_field_records(statement):",
  "    fields = []",
  "    if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name):",
  "        fields.append({",
  "            'name': statement.target.id,",
  "            'annotation': ast.unparse(statement.annotation),",
  "            'line': getattr(statement, 'lineno', 1),",
  "            'column': getattr(statement, 'col_offset', 0) + 1,",
  "        })",
  "    elif isinstance(statement, ast.Assign):",
  "        for target in statement.targets:",
  "            if isinstance(target, ast.Name):",
  "                fields.append({",
  "                    'name': target.id,",
  "                    'line': getattr(target, 'lineno', 1),",
  "                    'column': getattr(target, 'col_offset', 0) + 1,",
  "                })",
  "    return fields",
  "",
  "def self_field_records(node):",
  "    fields = []",
  "    for current in iter_non_nested(node):",
  "        if isinstance(current, ast.Assign):",
  "            for target in current.targets:",
  "                field_name = self_field_from_target(target)",
  "                if field_name is not None:",
  "                    fields.append({",
  "                        'name': field_name,",
  "                        'line': getattr(target, 'lineno', 1),",
  "                        'column': getattr(target, 'col_offset', 0) + 1,",
  "                    })",
  "        elif isinstance(current, ast.AnnAssign):",
  "            field_name = self_field_from_target(current.target)",
  "            if field_name is not None:",
  "                fields.append({",
  "                    'name': field_name,",
  "                    'annotation': ast.unparse(current.annotation),",
  "                    'line': getattr(current.target, 'lineno', 1),",
  "                    'column': getattr(current.target, 'col_offset', 0) + 1,",
  "                })",
  "    return fields",
  "",
  "def decorator_names(node):",
  "    names = []",
  "    for decorator in node.decorator_list:",
  "        name = expr_name(decorator)",
  "        if name:",
  "            names.append(name)",
  "    return names",
  "",
  "def method_record(node):",
  "    decorators = decorator_names(node)",
  "    return {",
  "        'name': node.name,",
  "        'line': getattr(node, 'lineno', 1),",
  "        'column': getattr(node, 'col_offset', 0) + 1,",
  "        'decorators': decorators,",
  "        'parameters': collect_parameters(node),",
  "        'calls': collect_calls(node),",
  "        'annotations': function_annotations(node),",
  "        'fastapiRoute': is_fastapi_route(decorators),",
  "    }",
  "",
  "def class_record(node):",
  "    fields = []",
  "    methods = []",
  "    annotations = []",
  "    for statement in node.body:",
  "        fields.extend(class_field_records(statement))",
  "        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):",
  "            methods.append(method_record(statement))",
  "            fields.extend(self_field_records(statement))",
  "            annotations.extend(function_annotations(statement))",
  "        elif isinstance(statement, ast.AnnAssign):",
  "            annotations.append(annotation_record(statement.annotation))",
  "    return {",
  "        'name': node.name,",
  "        'line': getattr(node, 'lineno', 1),",
  "        'column': getattr(node, 'col_offset', 0) + 1,",
  "        'bases': [expr_name(base) for base in node.bases if expr_name(base)],",
  "        'fields': fields,",
  "        'methods': methods,",
  "        'annotations': annotations,",
  "    }",
  "",
  "def function_record(node, parents):",
  "    decorators = decorator_names(node)",
  "    qualname = '.'.join(parents + [node.name]) if parents else node.name",
  "    return {",
  "        'name': node.name,",
  "        'qualname': qualname,",
  "        'line': getattr(node, 'lineno', 1),",
  "        'column': getattr(node, 'col_offset', 0) + 1,",
  "        'decorators': decorators,",
  "        'parameters': collect_parameters(node),",
  "        'calls': collect_calls(node),",
  "        'annotations': function_annotations(node),",
  "        'fastapiRoute': is_fastapi_route(decorators),",
  "    }",
  "",
  "def imports_from_tree(tree):",
  "    imports = []",
  "    for node in ast.walk(tree):",
  "        if isinstance(node, ast.Import):",
  "            for alias in node.names:",
  "                imports.append({",
  "                    'candidates': [alias.name],",
  "                    'line': getattr(node, 'lineno', 1),",
  "                    'column': getattr(node, 'col_offset', 0) + 1,",
  "                })",
  "        elif isinstance(node, ast.ImportFrom):",
  "            module = node.module or ''",
  "            for alias in node.names:",
  "                candidates = [module] if module else []",
  "                if module and alias.name != '*':",
  "                    candidates.append(f'{module}.{alias.name}')",
  "                imports.append({",
  "                    'candidates': sorted({candidate for candidate in candidates if candidate}),",
  "                    'line': getattr(node, 'lineno', 1),",
  "                    'column': getattr(node, 'col_offset', 0) + 1,",
  "                })",
  "    return imports",
  "",
  "def analyze_file(entry):",
  "    source = Path(entry['absolute_path']).read_text(encoding='utf-8-sig')",
  "    tree = ast.parse(source, filename=entry['relative_path'])",
  "    classes = []",
  "    functions = []",
  "    annotations = []",
  "    for node in tree.body:",
  "        if isinstance(node, ast.ClassDef):",
  "            record = class_record(node)",
  "            classes.append(record)",
  "            for method in record['methods']:",
  "                functions.append({",
  "                    'name': method['name'],",
  "                    'qualname': f\"{record['name']}.{method['name']}\",",
  "                    'line': method['line'],",
  "                    'column': method['column'],",
  "                    'decorators': method['decorators'],",
  "                    'parameters': method['parameters'],",
  "                    'calls': method['calls'],",
  "                    'annotations': method['annotations'],",
  "                    'fastapiRoute': method['fastapiRoute'],",
  "                })",
  "            annotations.extend(record['annotations'])",
  "        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):",
  "            record = function_record(node, [])",
  "            functions.append(record)",
  "            annotations.extend(record['annotations'])",
  "        elif isinstance(node, ast.AnnAssign):",
  "            annotations.append(annotation_record(node.annotation))",
  "    return {",
  "        'path': entry['relative_path'],",
  "        'imports': imports_from_tree(tree),",
  "        'calls': collect_calls(tree),",
  "        'annotations': annotations,",
  "        'classes': classes,",
  "        'functions': functions,",
  "    }",
  "",
  "def main(payload_path):",
  "    payload = json.loads(Path(payload_path).read_text(encoding='utf-8'))",
  "    result = {'files': [], 'errors': []}",
  "    for entry in payload['files']:",
  "        try:",
  "            result['files'].append(analyze_file(entry))",
  "        except SyntaxError as error:",
  "            result['errors'].append({",
  "                'path': entry['relative_path'],",
  "                'summary': f\"Python AST analysis failed for {entry['relative_path']}\",",
  "                'detail': error.msg,",
  "                'line': error.lineno,",
  "                'column': error.offset,",
  "            })",
  "        except Exception as error:",
  "            result['errors'].append({",
  "                'path': entry['relative_path'],",
  "                'summary': f\"Python AST analysis failed for {entry['relative_path']}\",",
  "                'detail': str(error),",
  "            })",
  "    sys.stdout.write(json.dumps(result))",
  "",
  "if __name__ == '__main__':",
  "    main(sys.argv[1])",
  "",
].join("\n");
