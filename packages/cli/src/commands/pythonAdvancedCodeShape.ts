import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import globParent from "glob-parent";
import { minimatch } from "minimatch";
import type { ClassShapeDeclaration, FunctionShapeDeclaration, TypePolicyDeclaration } from "@stele/core";

const execFileAsync = promisify(execFile);
const PYTHON_CANDIDATES: Array<{ command: string; args: string[] }> = [
  { command: "python", args: [] },
  { command: "py", args: ["-3"] },
  { command: "python3", args: [] },
];

type AdvancedDeclaration = ClassShapeDeclaration | FunctionShapeDeclaration | TypePolicyDeclaration;

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
};

type PythonFileAnalysis = {
  path: string;
  annotations: PythonAnnotation[];
  classes: PythonClass[];
  functions: PythonFunction[];
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

export type PythonAdvancedCodeShapeFinding = {
  findingKind: "rule_violation" | "execution_error";
  ruleId: string;
  declarationKind?: AdvancedDeclaration["kind"];
  location: {
    path: string;
    line?: number;
    column?: number;
  };
  cause: {
    summary: string;
    detail?: string;
  };
  fix: {
    summary: string;
  };
  scopePaths: string[];
};

export async function evaluatePythonAdvancedCodeShapes(options: {
  projectDir: string;
  declarations: AdvancedDeclaration[];
  command?: string;
}): Promise<PythonAdvancedCodeShapeFinding[]> {
  const { projectDir, declarations } = options;
  const command = options.command ?? "check";

  if (declarations.length === 0) {
    return [];
  }

  const targetMap = new Map<string, string[]>();

  for (const declaration of declarations) {
    const parsedTarget = parseTarget(declaration.target);
    targetMap.set(declaration.id, await expandTargetPattern(projectDir, parsedTarget.pathPattern));
  }

  const pythonFiles = [...new Set([...targetMap.values()].flat())];
  const analysis = await analyzePythonFiles(projectDir, pythonFiles, command);
  const fileAnalyses = new Map(analysis.files.map((file) => [file.path, file] as const));
  const findings = analysis.errors.map((error) => createExecutionErrorFinding(projectDir, error));

  for (const declaration of declarations) {
    const matchedFiles = targetMap.get(declaration.id) ?? [];

    switch (declaration.kind) {
      case "class-shape":
        findings.push(...evaluateClassShapeDeclaration(declaration, matchedFiles, fileAnalyses));
        break;
      case "function-shape":
        findings.push(...evaluateFunctionShapeDeclaration(declaration, matchedFiles, fileAnalyses));
        break;
      case "type-policy":
        findings.push(...evaluateTypePolicyDeclaration(declaration, matchedFiles, fileAnalyses));
        break;
    }
  }

  return findings;
}

let cachedPythonRuntime: Promise<PythonRuntime | undefined> | undefined;

async function analyzePythonFiles(projectDir: string, files: string[], command: string): Promise<PythonAnalysisResult> {
  if (files.length === 0) {
    return { files: [], errors: [] };
  }

  const runtime = await resolvePythonRuntime();

  if (runtime === undefined) {
    return {
      files: [],
      errors: [
        {
          path: "contract/main.stele",
          summary: "Python 3 is required to evaluate Python code-shape rules.",
          detail: 'Install Python 3 and make sure "python", "py -3", or "python3" is available on PATH.',
        },
      ],
    };
  }

  const workspaceDir = await mkdtemp(resolve(tmpdir(), "stele-python-advanced-code-shape-"));
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
      maxBuffer: 16 * 1024 * 1024,
    });

    return JSON.parse(stdout) as PythonAnalysisResult;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      files: [],
      errors: [
        {
          path: "contract/main.stele",
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
  cachedPythonRuntime ??= (async () => {
    for (const candidate of PYTHON_CANDIDATES) {
      try {
        await execFileAsync(candidate.command, [...candidate.args, "--version"], { windowsHide: true });
        return candidate;
      } catch {
        continue;
      }
    }

    return undefined;
  })();

  return cachedPythonRuntime;
}

function evaluateClassShapeDeclaration(
  declaration: ClassShapeDeclaration,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): PythonAdvancedCodeShapeFinding[] {
  const parsedTarget = parseTarget(declaration.target);
  const selectorValidation = validateNamedSelector("class-shape", declaration.id, parsedTarget);

  if (selectorValidation.error !== undefined) {
    return [createConfigurationFinding(declaration.filePath, declaration.id, selectorValidation.error)];
  }

  const classMatches = collectClassMatches(parsedTarget, matchedFiles, fileAnalyses);

  if (classMatches.length === 0) {
    return [
      createRuleFinding({
        declaration,
        filePath: matchedFiles[0] ?? parsedTarget.pathPattern,
        summary: `Target class "${parsedTarget.selectorName}" was not found.`,
        detail: `Class shape "${declaration.id}" expects a class selector that resolves inside "${parsedTarget.pathPattern}".`,
        fixSummary: `Define "${parsedTarget.selectorName}" in a file matched by "${parsedTarget.pathPattern}" or update the target selector.`,
        scopePaths: createScopePaths(declaration.filePath, matchedFiles, parsedTarget.pathPattern),
      }),
    ];
  }

  const findings: PythonAdvancedCodeShapeFinding[] = [];

  for (const match of classMatches) {
    for (const requiredField of declaration.mustHaveFields) {
      const fields = match.classInfo.fields.filter((field) => field.name === requiredField.name);

      if (fields.length === 0) {
        findings.push(
          createRuleFinding({
            declaration,
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

        findings.push(
          createRuleFinding({
            declaration,
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
        findings.push(
          createRuleFinding({
            declaration,
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
        findings.push(
          createRuleFinding({
            declaration,
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

  return findings;
}

function evaluateFunctionShapeDeclaration(
  declaration: FunctionShapeDeclaration,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): PythonAdvancedCodeShapeFinding[] {
  const parsedTarget = parseTarget(declaration.target);
  const selectorValidation = validateFunctionSelector(declaration.id, parsedTarget);

  if (selectorValidation.error !== undefined) {
    return [createConfigurationFinding(declaration.filePath, declaration.id, selectorValidation.error)];
  }

  const functionMatches = collectFunctionMatches(parsedTarget, matchedFiles, fileAnalyses);

  if (functionMatches.length === 0) {
    const selectorLabel = parsedTarget.selectorName ?? `[${parsedTarget.selectorFilter}]`;
    return [
      createRuleFinding({
        declaration,
        filePath: matchedFiles[0] ?? parsedTarget.pathPattern,
        summary: `Target function selector "${selectorLabel}" matched no Python functions.`,
        detail: `Function shape "${declaration.id}" expects a function inside "${parsedTarget.pathPattern}".`,
        fixSummary: `Add a matching function to "${parsedTarget.pathPattern}" or update the selector.`,
        scopePaths: createScopePaths(declaration.filePath, matchedFiles, parsedTarget.pathPattern),
      }),
    ];
  }

  const findings: PythonAdvancedCodeShapeFinding[] = [];

  for (const match of functionMatches) {
    for (const requiredParameter of declaration.mustHaveParameters) {
      if (!match.functionInfo.parameters.includes(requiredParameter)) {
        findings.push(
          createRuleFinding({
            declaration,
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
        findings.push(
          createRuleFinding({
            declaration,
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
      if (!match.functionInfo.calls.some((called) => minimatch(called.name, requiredCall, { windowsPathsNoEscape: true }))) {
        findings.push(
          createRuleFinding({
            declaration,
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

  return findings;
}

function evaluateTypePolicyDeclaration(
  declaration: TypePolicyDeclaration,
  matchedFiles: string[],
  fileAnalyses: Map<string, PythonFileAnalysis>,
): PythonAdvancedCodeShapeFinding[] {
  const parsedTarget = parseTarget(declaration.target);
  const annotations = collectAnnotationsForTarget(parsedTarget, matchedFiles, fileAnalyses);
  const findings: PythonAdvancedCodeShapeFinding[] = [];

  for (const deniedType of declaration.denyTypes) {
    for (const annotation of annotations) {
      if (!annotationUsesType(annotation.annotation, deniedType)) {
        continue;
      }

      findings.push(
        createRuleFinding({
          declaration,
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

    findings.push(
      createRuleFinding({
        declaration,
        filePath: matchedFiles[0] ?? parsedTarget.pathPattern,
        summary: `Type policy "${declaration.id}" requires annotation "${requiredType}" in the matched scope.`,
        detail: `No annotation matching "${requiredType}" was found.`,
        fixSummary: `Add an annotation using "${requiredType}" within files matched by "${parsedTarget.pathPattern}".`,
        scopePaths: createScopePaths(declaration.filePath, matchedFiles, parsedTarget.pathPattern),
      }),
    );
  }

  return findings;
}

function createRuleFinding(options: {
  declaration: AdvancedDeclaration;
  filePath: string;
  summary: string;
  detail: string;
  fixSummary: string;
  line?: number;
  column?: number;
  scopePaths?: string[];
}): PythonAdvancedCodeShapeFinding {
  return {
    findingKind: "rule_violation",
    ruleId: options.declaration.id,
    declarationKind: options.declaration.kind,
    location: {
      path: options.filePath,
      line: options.line,
      column: options.column,
    },
    cause: {
      summary: options.summary,
      detail: options.detail,
    },
    fix: {
      summary: options.fixSummary,
    },
    scopePaths: options.scopePaths ?? uniqueSortedStrings([options.filePath, options.declaration.filePath]),
  };
}

function createExecutionErrorFinding(projectDir: string, error: PythonAnalysisError): PythonAdvancedCodeShapeFinding {
  return {
    findingKind: "execution_error",
    ruleId: "stele.check.execution_error",
    location: {
      path: normalizePath(error.path, projectDir),
      line: error.line,
      column: error.column,
    },
    cause: {
      summary: error.summary,
      detail: error.detail,
    },
    fix: {
      summary: "Fix the Python analysis error and re-run stele check.",
    },
    scopePaths: [normalizePath(error.path, projectDir)],
  };
}

function createConfigurationFinding(contractPath: string, ruleId: string, summary: string): PythonAdvancedCodeShapeFinding {
  return {
    findingKind: "execution_error",
    ruleId: "stele.check.execution_error",
    location: {
      path: contractPath,
    },
    cause: {
      summary,
      detail: `Rule "${ruleId}" has an invalid target selector.`,
    },
    fix: {
      summary: `Update code-shape "${ruleId}" so its target selector is valid.`,
    },
    scopePaths: [contractPath],
  };
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

  return files.filter((file) => minimatch(file, normalizedPattern, { windowsPathsNoEscape: true }));
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

  return files.sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizePath(path: string, projectDir: string): string {
  return path.includes(":") || path.startsWith("/") ? toProjectRelativePath(projectDir, path) : normalizeRelativePath(path);
}

function toProjectRelativePath(projectDir: string, path: string): string {
  const relativePath = normalizeRelativePath(relative(resolve(projectDir), resolve(path)));
  return relativePath.length === 0 ? "." : relativePath;
}

function matchesNamedReference(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`.${expected}`);
}

function annotationUsesType(annotation: PythonAnnotation, expectedType: string): boolean {
  return annotation.text === expectedType || annotation.names.some((name) => name === expectedType || name.endsWith(`.${expectedType}`));
}

function createScopePaths(contractPath: string, matchedFiles: string[], fallbackPath: string): string[] {
  return uniqueSortedStrings([contractPath, ...(matchedFiles.length === 0 ? [fallbackPath] : matchedFiles)]);
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sanitizePythonExecutionDetail(detail: string, command: string): string {
  return detail.replace(/\s+/g, " ").replaceAll(command, "stele check").trim();
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
  "def analyze_file(entry):",
  "    source = Path(entry['absolute_path']).read_text(encoding='utf-8')",
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
