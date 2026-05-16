import {
  type BoundaryDeclaration,
  type ClassShapeDeclaration,
  type CodeShapeDeclaration,
  type FilePolicyDeclaration,
  type FunctionShapeDeclaration,
  type TypePolicyDeclaration,
} from "@stele/core";
import { SteleError } from "@stele/core";
import {
  INDENT,
  CODE_SHAPE_RUNTIME_HELPERS,
  PYTHON_RESERVED_WORDS,
  type CodeShapeTarget,
} from "./types.js";
import { allocateUniquePythonName, sanitizePythonIdentifier, toPythonString } from "./translation-utils.js";

// ---------------------------------------------------------------------------
// Code shape target parsing
// ---------------------------------------------------------------------------

export function parseCodeShapeTarget(target: string): CodeShapeTarget {
  const separator = target.indexOf("::");
  if (separator === -1) {
    return { pathPattern: target };
  }
  const pathPattern = target.slice(0, separator);
  const selector = target.slice(separator + 2).trim();
  if (selector.startsWith("[") && selector.endsWith("]")) {
    return { pathPattern, selectorFilter: selector.slice(1, -1) };
  }
  const filterIndex = selector.indexOf("[");
  if (filterIndex !== -1 && selector.endsWith("]")) {
    return {
      pathPattern,
      selectorName: selector.slice(0, filterIndex),
      selectorFilter: selector.slice(filterIndex + 1, -1),
    };
  }
  return { pathPattern, selectorName: selector };
}

// ---------------------------------------------------------------------------
// Module path resolution
// ---------------------------------------------------------------------------

export function fileToModulePath(declaration: CodeShapeDeclaration, pathPattern: string): string {
  if (/[*?\[\]]/.test(pathPattern)) {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Code shape "${declaration.id}" target ${JSON.stringify(pathPattern)} cannot use glob metacharacters when a class or function selector is present.`,
      declaration.span,
      `${declaration.kind} declarations need a literal file path so the Python backend can resolve a single module.`,
      `Use a single file like (target "app/account.py::Account").`,
    );
  }
  if (!pathPattern.endsWith(".py")) {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Code shape "${declaration.id}" target ${JSON.stringify(pathPattern)} must end with ".py".`,
      declaration.span,
      "Python module resolution needs a .py file path so the backend can derive the dotted module name.",
      `Use a target like (target "app/account.py::Account").`,
    );
  }
  const stripped = pathPattern.slice(0, -3);
  const segments = stripped.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Code shape "${declaration.id}" target ${JSON.stringify(pathPattern)} did not yield any module segments.`,
      declaration.span,
      "Python module resolution needs at least one path segment so the backend can derive a dotted module name.",
      `Use a target like (target "app/account.py::Account").`,
    );
  }
  if (segments[segments.length - 1] === "__init__") {
    segments.pop();
  }
  for (const segment of segments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new SteleError(
        "E0608",
        "Backend Error",
        `Code shape "${declaration.id}" target segment ${JSON.stringify(segment)} is not a valid Python identifier.`,
        declaration.span,
        "Each path segment must form a valid Python module name.",
        "Rename the directory/file so each component is a Python identifier.",
      );
    }
  }
  return segments.join(".");
}

// ---------------------------------------------------------------------------
// Test name allocation
// ---------------------------------------------------------------------------

export function codeShapeTestPrefix(kind: CodeShapeDeclaration["kind"]): string {
  switch (kind) {
    case "boundary":
      return "boundary";
    case "class-shape":
      return "class_shape";
    case "function-shape":
      return "function_shape";
    case "type-policy":
      return "type_policy";
    case "file-policy":
      return "file_policy";
  }
}

// ---------------------------------------------------------------------------
// Code shape test rendering
// ---------------------------------------------------------------------------

export function renderCodeShapeTest(declaration: CodeShapeDeclaration, testName: string): string[] {
  const header = `def ${testName}(stele_context):`;
  let body: string[];
  switch (declaration.kind) {
    case "class-shape":
      body = renderClassShapeBody(declaration);
      break;
    case "function-shape":
      body = renderFunctionShapeBody(declaration);
      break;
    case "boundary":
      body = renderBoundaryBody(declaration);
      break;
    case "type-policy":
      body = renderTypePolicyBody(declaration);
      break;
    case "file-policy":
      body = renderFilePolicyBody(declaration);
      break;
  }
  if (body.length === 0) {
    body = [`${INDENT}pass`];
  }
  return [header, ...body];
}

// ---------------------------------------------------------------------------
// Class shape body
// ---------------------------------------------------------------------------

function renderClassShapeBody(declaration: ClassShapeDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  if (target.selectorName === undefined || target.selectorName === "") {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Class shape "${declaration.id}" must specify a class name after "::" (e.g. "app/account.py::Account").`,
      declaration.span,
      "The Python backend resolves a single class via importlib; a glob target alone is ambiguous.",
      `Add a class name to the target.`,
    );
  }
  const modulePath = fileToModulePath(declaration, target.pathPattern);
  const qualified = `${modulePath}.${target.selectorName}`;
  const lines: string[] = [];
  lines.push(`${INDENT}cls = stele_resolve_class(${toPythonString(qualified)})`);

  for (const field of declaration.mustHaveFields) {
    const failureMessage = field.type === undefined
      ? `class-shape ${declaration.id}: field ${JSON.stringify(field.name)} missing on ${qualified}`
      : `class-shape ${declaration.id}: field ${JSON.stringify(field.name)} missing or wrong type (expected ${field.type}) on ${qualified}`;
    if (field.type === undefined) {
      lines.push(`${INDENT}if not stele_has_field(cls, ${toPythonString(field.name)}):`);
    } else {
      lines.push(
        `${INDENT}if not stele_has_field(cls, ${toPythonString(field.name)}, expected_type=${toPythonString(field.type)}):`,
      );
    }
    lines.push(`${INDENT}${INDENT}pytest.fail(${toPythonString(failureMessage)})`);
  }

  for (const method of declaration.mustHaveMethods) {
    lines.push(`${INDENT}if not stele_has_callable(cls, ${toPythonString(method)}):`);
    lines.push(
      `${INDENT}${INDENT}pytest.fail(${toPythonString(`class-shape ${declaration.id}: method ${JSON.stringify(method)} missing or not callable on ${qualified}`)})`,
    );
  }

  for (const base of declaration.mustExtend) {
    const baseExpr = `getattr(cls_base, "__name__", None) == ${toPythonString(base)} or getattr(cls_base, "__qualname__", "").endswith(${toPythonString(`.${base}`)})`;
    lines.push(`${INDENT}if not any(${baseExpr} for cls_base in getattr(cls, "__mro__", [cls])[1:]):`);
    lines.push(
      `${INDENT}${INDENT}pytest.fail(${toPythonString(`class-shape ${declaration.id}: ${qualified} must extend ${base}`)})`,
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Function shape body
// ---------------------------------------------------------------------------

function renderFunctionShapeBody(declaration: FunctionShapeDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  if (target.selectorName === undefined || target.selectorName === "") {
    throw new SteleError(
      "E0608",
      "Backend Error",
      `Function shape "${declaration.id}" must specify a function name after "::" (e.g. "app/totals.py::calculate_total").`,
      declaration.span,
      "The Python backend resolves a single function via importlib; a glob target alone is ambiguous.",
      `Add a function name to the target.`,
    );
  }
  const modulePath = fileToModulePath(declaration, target.pathPattern);
  const selectorParts = target.selectorName.split(".");
  const symbolName = selectorParts.pop()!;
  const owningModule = selectorParts.length === 0 ? modulePath : `${modulePath}.${selectorParts.join(".")}`;
  const qualified = `${owningModule}.${symbolName}`;
  const lines: string[] = [];
  lines.push(`${INDENT}fn = stele_resolve_function(${toPythonString(qualified)})`);

  if (declaration.mustHaveParameters.length > 0) {
    lines.push(`${INDENT}signature = inspect.signature(fn)`);
    lines.push(`${INDENT}actual_parameters = list(signature.parameters.keys())`);
    for (const parameter of declaration.mustHaveParameters) {
      const snake = kebabToSnake(parameter);
      lines.push(`${INDENT}if ${toPythonString(snake)} not in actual_parameters:`);
      lines.push(
        `${INDENT}${INDENT}pytest.fail(${toPythonString(`function-shape ${declaration.id}: missing parameter ${snake} on ${qualified}`)})`,
      );
    }
  }

  if (declaration.mustHaveDecorators.length > 0) {
    lines.push(`${INDENT}fn_decorators = list(getattr(fn, "__stele_decorators__", []))`);
    lines.push(`${INDENT}fn_wraps = getattr(fn, "__wrapped__", None)`);
    lines.push(`${INDENT}if fn_wraps is not None:`);
    lines.push(`${INDENT}${INDENT}fn_decorators.append(getattr(fn_wraps, "__name__", ""))`);
    for (const decorator of declaration.mustHaveDecorators) {
      const snake = kebabToSnake(decorator);
      lines.push(
        `${INDENT}if not any(name == ${toPythonString(snake)} or name.endswith(${toPythonString(`.${snake}`)}) for name in fn_decorators):`,
      );
      lines.push(
        `${INDENT}${INDENT}pytest.fail(${toPythonString(`function-shape ${declaration.id}: decorator ${snake} not detectable on ${qualified} (runtime cannot inspect source decorators reliably; see stele check for AST-based verification)`)})`,
      );
    }
  }

  if (declaration.mustHaveCalls.length > 0) {
    lines.push(
      `${INDENT}# must-have-call rules are enforced by AST analysis in 'stele check';`,
    );
    lines.push(
      `${INDENT}# the runtime test below only verifies the function exists and is callable.`,
    );
  }

  lines.push(`${INDENT}return_hints = stele_get_type_hints(fn)`);
  lines.push(`${INDENT}if "return" in return_hints:`);
  lines.push(`${INDENT}${INDENT}# Return type recorded for downstream type-policy checks; no assertion here.`);
  lines.push(`${INDENT}${INDENT}pass`);
  return lines;
}

// ---------------------------------------------------------------------------
// Boundary body
// ---------------------------------------------------------------------------

function renderBoundaryBody(declaration: BoundaryDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  const lines: string[] = [];
  const allowedExpr = renderPythonStringList(declaration.allowTargets);
  const deniedExpr = renderPythonStringList(declaration.denyImports);
  lines.push(`${INDENT}matched = stele_glob(${toPythonString(target.pathPattern)})`);
  lines.push(`${INDENT}allowed_targets = ${allowedExpr}`);
  lines.push(`${INDENT}denied_imports = ${deniedExpr}`);
  lines.push(`${INDENT}for filepath in matched:`);
  lines.push(`${INDENT}${INDENT}if any(stele_import_allowed(filepath, allowed=[pattern]) for pattern in allowed_targets):`);
  lines.push(`${INDENT}${INDENT}${INDENT}continue`);
  lines.push(`${INDENT}${INDENT}imports = stele_collect_imports(filepath)`);
  lines.push(`${INDENT}${INDENT}for imp in imports:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if not stele_import_allowed(imp, allowed=[], forbidden=denied_imports):`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`boundary ${declaration.id}: forbidden import `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ repr(imp) + ${toPythonString(" in ")} + repr(filepath)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  return lines;
}

// ---------------------------------------------------------------------------
// Type policy body
// ---------------------------------------------------------------------------

function renderTypePolicyBody(declaration: TypePolicyDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  const lines: string[] = [];

  if (target.selectorName !== undefined && target.selectorName !== "") {
    const modulePath = fileToModulePath(declaration, target.pathPattern);
    const qualified = `${modulePath}.${target.selectorName}`;
    lines.push(`${INDENT}cls = stele_resolve_class(${toPythonString(qualified)})`);
    lines.push(`${INDENT}fields = stele_get_class_fields(cls)`);

    for (const requiredType of declaration.requireTypes) {
      lines.push(`${INDENT}if not any(stele_type_matches(field_type, ${toPythonString(requiredType)}) for field_type in fields.values()):`);
      lines.push(
        `${INDENT}${INDENT}pytest.fail(${toPythonString(`type-policy ${declaration.id}: ${qualified} has no field of type ${requiredType}`)})`,
      );
    }
    for (const denied of declaration.denyTypes) {
      lines.push(`${INDENT}for field_name, field_type in fields.items():`);
      lines.push(`${INDENT}${INDENT}if stele_type_matches(field_type, ${toPythonString(denied)}):`);
      lines.push(`${INDENT}${INDENT}${INDENT}message = (`);
      lines.push(
        `${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`type-policy ${declaration.id}: ${qualified} field `)}`,
      );
      lines.push(
        `${INDENT}${INDENT}${INDENT}${INDENT}+ str(field_name) + ${toPythonString(` uses denied type ${denied}`)}`,
      );
      lines.push(`${INDENT}${INDENT}${INDENT})`);
      lines.push(`${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
    }
    return lines;
  }

  lines.push(`${INDENT}required_names = ${renderPythonStringList(declaration.requireTypes)}`);
  lines.push(`${INDENT}denied_names = ${renderPythonStringList(declaration.denyTypes)}`);
  lines.push(`${INDENT}seen_required = {name: False for name in required_names}`);
  lines.push(`${INDENT}for filepath in stele_glob(${toPythonString(target.pathPattern)}):`);
  lines.push(`${INDENT}${INDENT}text = stele_read_file(filepath)`);
  lines.push(`${INDENT}${INDENT}for name in required_names:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if name in text:`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}seen_required[name] = True`);
  lines.push(`${INDENT}${INDENT}for name in denied_names:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if name in text:`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`type-policy ${declaration.id}: file `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ str(filepath) + ${toPythonString(" uses denied type ")} + str(name)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  lines.push(`${INDENT}for name, was_seen in seen_required.items():`);
  lines.push(`${INDENT}${INDENT}if not was_seen:`);
  lines.push(`${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`type-policy ${declaration.id}: required type `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}+ str(name) + ${toPythonString(" not found in matched files")}`);
  lines.push(`${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  return lines;
}

// ---------------------------------------------------------------------------
// File policy body
// ---------------------------------------------------------------------------

function renderFilePolicyBody(declaration: FilePolicyDeclaration): string[] {
  const target = parseCodeShapeTarget(declaration.target);
  const lines: string[] = [];
  lines.push(`${INDENT}required_substrings = ${renderPythonStringList(declaration.mustContain)}`);
  lines.push(`${INDENT}required_endings = ${renderPythonStringList(declaration.mustEndWith)}`);
  lines.push(`${INDENT}for filepath in stele_glob(${toPythonString(target.pathPattern)}):`);
  lines.push(`${INDENT}${INDENT}text = stele_read_file(filepath)`);
  lines.push(`${INDENT}${INDENT}for needle in required_substrings:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if needle not in text:`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`file-policy ${declaration.id}: file `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ str(filepath) + ${toPythonString(" missing required substring ")} + repr(needle)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  lines.push(`${INDENT}${INDENT}for ending in required_endings:`);
  lines.push(`${INDENT}${INDENT}${INDENT}if not text.endswith(ending):`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}message = (`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}${toPythonString(`file-policy ${declaration.id}: file `)}`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}+ str(filepath) + ${toPythonString(" does not end with ")} + repr(ending)`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT})`);
  lines.push(`${INDENT}${INDENT}${INDENT}${INDENT}pytest.fail(message)`);
  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPythonStringList(values: readonly string[]): string {
  if (values.length === 0) {
    return "[]";
  }
  return `[${values.map((value) => toPythonString(value)).join(", ")}]`;
}

function kebabToSnake(name: string): string {
  return name.replaceAll("-", "_");
}

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

export function generatePytestCodeShapeSource(contract: {
  codeShapes: CodeShapeDeclaration[];
}): string {
  const declarations = contract.codeShapes.slice().sort(compareCodeShapes);
  const usedTestNames = new Set<string>();
  const bodyLines: string[] = [];

  declarations.forEach((declaration, index) => {
    const testName = allocateUniquePythonName(
      `test_${codeShapeTestPrefix(declaration.kind)}_${sanitizePythonIdentifier(declaration.id, "code_shape")}`,
      usedTestNames,
    );
    usedTestNames.add(testName);
    bodyLines.push(...renderCodeShapeTest(declaration, testName));
    if (index !== declarations.length - 1) {
      bodyLines.push("");
      bodyLines.push("");
    }
  });

  const lines = [buildCodeShapeImportLine(), "", "", ...bodyLines, ""];
  return lines.join("\n");
}

function compareCodeShapes(left: CodeShapeDeclaration, right: CodeShapeDeclaration): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    left.span.line - right.span.line ||
    left.span.column - right.span.column ||
    left.id.localeCompare(right.id)
  );
}

function buildCodeShapeImportLine(): string {
  const helpers = ["pytest"].join(", ");
  const runtimeHelpers = CODE_SHAPE_RUNTIME_HELPERS.join(", ");
  return [
    `import inspect`,
    `import ${helpers}`,
    `from ._stele_runtime import ${runtimeHelpers}`,
  ].join("\n");
}
