import { SteleError, type CodeShapeDeclaration } from "@stele/core";
import { type CodeShapeTarget } from "./types.js";

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
