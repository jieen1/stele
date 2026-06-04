import { MAX_CHILD_PROCESS_BUFFER } from "../config/defaults.js";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile, lstat } from "node:fs/promises";
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
  type CodeShapeDeclaration,
  type Contract,
  type Violation,
} from "@stele/core";
import { stableStringCompare } from "@stele/core";
import { analyzeTypeScriptFiles, isTypeScriptFilePath } from "./typescript-analyzer.js";
import {
  createConfigurationViolation,
  normalizeRelativePath,
  parseTarget,
  toProjectRelativePath,
  type PythonFileAnalysis,
} from "./code-shape-common.js";
import { evaluateBoundaryDeclaration } from "./eval-boundary.js";
import { evaluateClassShapeDeclaration } from "./eval-class-shape.js";
import { evaluateFunctionShapeDeclaration } from "./eval-function-shape.js";
import { evaluateTypePolicyDeclaration } from "./eval-type-policy.js";
import { evaluateFilePolicyDeclaration } from "./eval-file-policy.js";

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

type PythonRuntime = {
  command: string;
  args: string[];
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
