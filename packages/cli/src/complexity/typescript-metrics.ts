import * as ts from "typescript";
import type {
  CoreNodeMeasurement,
  CoreNodeMetricValue,
} from "./types.js";
import { parseCoreNodeTarget, getMetricStatus } from "./types.js";

// ----------------------------------------------------------------
// Character constants
// ----------------------------------------------------------------

const CHAR_SLASH = "/";
const CHAR_STAR = "*";
const CHAR_DOUBLE_QUOTE = '"';
const CHAR_SINGLE_QUOTE = "'";
const CHAR_BACKTICK = "`";
const CHAR_BACKSLASH = "\\";
const CHAR_SPACE = " ";
const CHAR_TAB = "\t";
const CHAR_CR = "\r";
const CHAR_LF = "\n";

// ----------------------------------------------------------------
// SLOC (Source Lines of Code)
// ----------------------------------------------------------------

/**
 * Count non-blank, non-comment lines in the class body.
 * Excludes JSDoc, single-line //, multi-line block comments, and blank lines.
 */
export function countSLOC(source: string, classNode: ts.ClassDeclaration): number {
  const name = classNode.name;
  if (name === undefined || name === null) {
    return 0;
  }
  const nameEnd = name.getEnd();
  let bodyStart = nameEnd;

  // Scan forward to the class BODY's opening brace. Anything between the name
  // and that brace is a heritage clause (`extends X`, `implements Y, Z`) or a
  // type-parameter list — none of which contain a `{`. The previous version
  // broke out of the loop on the first non-whitespace char (the `e` of
  // `extends` / `i` of `implements`), found no `{`, and returned 0 SLOC for
  // every class with a heritage clause.
  while (bodyStart < source.length) {
    const ch = source[bodyStart];
    if (ch === CHAR_SLASH && source[bodyStart + 1] === CHAR_STAR) {
      const commentEnd = findBlockCommentEnd(source, bodyStart);
      if (commentEnd < 0) {
        return 0;
      }
      bodyStart = commentEnd;
      continue;
    }
    if (ch === "{") {
      break;
    }
    bodyStart++;
  }

  if (source[bodyStart] !== "{") {
    return 0;
  }

  const classEnd = classNode.getEnd();
  const body = source.slice(bodyStart, classEnd);

  // Count code lines using a single-pass scanner that handles
  // multi-line block comments properly.
  return countCodeLines(body);
}

/**
 * Count lines that contain code (not blank or comment-only).
 * Handles multi-line block comments.
 *
 * Skips the first line (opening {) and last line (closing }).
 */
function countCodeLines(body: string): number {
  const lines = body.split(CHAR_LF);
  // Remove first and last lines (braces)
  const innerLines = lines.length > 2 ? lines.slice(1, -1) : lines.slice(1);
  let count = 0;
  let inBlockComment = false;

  for (const line of innerLines) {
    if (inBlockComment) {
      const endIdx = findBlockCommentEnd(line, 0);
      if (endIdx < 0) {
        // Entire line is inside block comment
        continue;
      }
      // Found end of block comment; check if rest of line has code
      inBlockComment = false;
      const rest = line.slice(endIdx);
      if (lineHasCode(rest)) {
        count++;
      }
      continue;
    }

    // Not in block comment; scan this line
    const result = scanLine(line);
    switch (result.status) {
      case "code":
        count++;
        break;
      case "block-comment":
        inBlockComment = true;
        break;
      // "blank" and "single-comment" mean no code this line
    }
  }

  return count;
}

type LineResult =
  | { status: "code" }
  | { status: "single-comment" }
  | { status: "block-comment" }
  | { status: "blank" };

function scanLine(line: string): LineResult {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (ch === CHAR_SLASH && line[i + 1] === CHAR_SLASH) {
      return { status: "single-comment" };
    }

    if (ch === CHAR_SLASH && line[i + 1] === CHAR_STAR) {
      const endIdx = findBlockCommentEndOnLine(line, i);
      if (endIdx < 0) {
        return { status: "block-comment" };
      }
      // Block comment ends on this line; check if rest has code
      const rest = line.slice(endIdx);
      // Scan the rest of the line recursively
      const restResult = scanFromPosition(rest);
      return restResult;
    }

    if (
      ch === CHAR_DOUBLE_QUOTE ||
      ch === CHAR_SINGLE_QUOTE ||
      ch === CHAR_BACKTICK
    ) {
      i = skipStringLiteral(line, ch, i);
      continue;
    }

    if (!isWhitespace(ch)) {
      return { status: "code" };
    }

    i++;
  }
  return { status: "blank" };
}

function scanFromPosition(line: string): LineResult {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (ch === CHAR_SLASH && line[i + 1] === CHAR_SLASH) {
      return { status: "single-comment" };
    }

    if (ch === CHAR_SLASH && line[i + 1] === CHAR_STAR) {
      const endIdx = findBlockCommentEndOnLine(line, i);
      if (endIdx < 0) {
        return { status: "block-comment" };
      }
      const rest = line.slice(endIdx);
      return scanFromPosition(rest);
    }

    if (
      ch === CHAR_DOUBLE_QUOTE ||
      ch === CHAR_SINGLE_QUOTE ||
      ch === CHAR_BACKTICK
    ) {
      i = skipStringLiteral(line, ch, i);
      continue;
    }

    if (!isWhitespace(ch)) {
      return { status: "code" };
    }

    i++;
  }
  return { status: "blank" };
}

function findBlockCommentEnd(source: string, start: number): number {
  let i = start + 2;
  while (i < source.length - 1) {
    if (source[i] === CHAR_STAR && source[i + 1] === CHAR_SLASH) {
      return i + 2;
    }
    i++;
  }
  return -1;
}

function findBlockCommentEndOnLine(line: string, start: number): number {
  let i = start + 2;
  while (i < line.length - 1) {
    if (line[i] === CHAR_STAR && line[i + 1] === CHAR_SLASH) {
      return i + 2;
    }
    i++;
  }
  return -1;
}

function skipStringLiteral(line: string, quote: string, start: number): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === CHAR_BACKSLASH && i + 1 < line.length) {
      i += 2;
      continue;
    }
    if (line[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return line.length;
}

function isWhitespace(ch: string): boolean {
  return ch === CHAR_SPACE || ch === CHAR_TAB || ch === CHAR_CR || ch === CHAR_LF;
}

function lineHasCode(line: string): boolean {
  for (const ch of line) {
    if (!isWhitespace(ch)) {
      return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------
// Public Method Count
// ----------------------------------------------------------------

function isPrivate(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.Modifier> }).modifiers;
  return mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword) ?? false;
}

function isProtected(node: ts.Node): boolean {
  const mods = (node as { modifiers?: ts.NodeArray<ts.Modifier> }).modifiers;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword) ?? false;
}

/**
 * Check if a declaration is a public method-like member.
 */
function isPublicMethodLike(node: ts.Node): boolean {
  if (ts.isMethodDeclaration(node)) {
    return !isPrivate(node) && !isProtected(node);
  }
  if (ts.isGetAccessor(node)) {
    return !isPrivate(node) && !isProtected(node);
  }
  if (ts.isSetAccessor(node)) {
    return !isPrivate(node) && !isProtected(node);
  }
  return false;
}

/**
 * Count public methods on the class (including getters/setters).
 */
export function countPublicMethods(
  classNode: ts.ClassDeclaration,
): number {
  let count = 0;

  for (const member of classNode.members) {
    if (
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessor(member) ||
      ts.isSetAccessor(member)
    ) {
      if (isPublicMethodLike(member)) {
        count++;
      }
    }
  }

  return count;
}

// ----------------------------------------------------------------
// Max Cyclomatic Complexity
// ----------------------------------------------------------------

function isDoWhileStatement(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.DoStatement;
}

/**
 * Count decision points in a method body.
 *
 * Decision points: if, for, while, catch, ?:, &&, ||, case (in switch).
 * Method complexity = 1 + decision points.
 */
function countMethodComplexity(methodNode: ts.MethodDeclaration): number {
  let complexity = 1;

  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      complexity++;
    }

    if (ts.isForStatement(node) || ts.isForOfStatement(node)) {
      complexity++;
    }

    if (ts.isWhileStatement(node)) {
      complexity++;
    }

    if (isDoWhileStatement(node)) {
      complexity++;
    }

    if (ts.isCatchClause(node)) {
      complexity++;
    }

    if (ts.isConditionalExpression(node)) {
      complexity++;
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken;
      if (
        op.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        op.kind === ts.SyntaxKind.BarBarToken
      ) {
        complexity++;
      }
    }

    if (ts.isCaseClause(node)) {
      complexity++;
    }

    ts.forEachChild(node, visit);
  };

  const body = methodNode.body;
  if (body !== undefined) {
    ts.forEachChild(body, visit);
  }

  return complexity;
}

/**
 * Compute the maximum cyclomatic complexity across all public methods of a class.
 * Returns 0 if the class has no public methods.
 */
export function computeMaxCyclomaticComplexity(
  classNode: ts.ClassDeclaration,
): number {
  let max = 0;

  for (const member of classNode.members) {
    if (ts.isMethodDeclaration(member) && isPublicMethodLike(member)) {
      const c = countMethodComplexity(member);
      if (c > max) {
        max = c;
      }
    }
  }

  return max;
}

// ----------------------------------------------------------------
// Find Class Helper
// ----------------------------------------------------------------

/**
 * Find a named class declaration in a TypeScript source file.
 */
export function findClassByName(
  sourceFile: ts.SourceFile,
  className: string,
): ts.ClassDeclaration | undefined {
  let found: ts.ClassDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined && node.name.text === className) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Find a named function declaration, exported function variable, or export alias
 * in a source file. When an export alias is found (e.g., `export { X as Y }`),
 * resolve to the underlying function/variable declaration.
 */
export function findFunctionByName(
  sourceFile: ts.SourceFile,
  functionName: string,
): ts.FunctionDeclaration | ts.VariableDeclaration | undefined {
  let found: ts.FunctionDeclaration | ts.VariableDeclaration | undefined;

  // First pass: direct match on function declaration or variable
  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.name.text === functionName) {
      found = node;
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  // Second pass: check for export alias (e.g., `export { X as Y }`)
  if (found === undefined) {
    const resolveAlias = (node: ts.Node): void => {
      if (found) return;

      // Match export { originalName as aliasName }
      if (ts.isExportSpecifier(node) && node.name && node.name.text === functionName) {
        // `propertyName` (TS5) holds the original identifier
        const originalName = node.propertyName;
        if (originalName && ts.isIdentifier(originalName)) {
          // Now search for the original name
          const searchForOriginal = (n: ts.Node): void => {
            if (found) return;
            if (ts.isFunctionDeclaration(n) && n.name !== undefined && n.name.text === originalName.text) {
              found = n;
              return;
            }
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === originalName.text) {
              found = n;
              return;
            }
            ts.forEachChild(n, searchForOriginal);
          };
          ts.forEachChild(sourceFile, searchForOriginal);
        }
        return;
      }

      ts.forEachChild(node, resolveAlias);
    };

    ts.forEachChild(sourceFile, resolveAlias);
  }

  return found;
}

/**
 * Find a named interface declaration in a TypeScript source file.
 */
export function findInterfaceByName(
  sourceFile: ts.SourceFile,
  interfaceName: string,
): ts.InterfaceDeclaration | undefined {
  let found: ts.InterfaceDeclaration | undefined;

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

// ----------------------------------------------------------------
// Main Entry Point
// ----------------------------------------------------------------

export function extractClassMetrics(
  sourcePath: string,
  source: string,
  className: string,
  boundaries: Array<{
    name: string;
    ideal: number;
    max: number;
  }>,
): CoreNodeMeasurement | null {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };

  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    compilerOptions.target ?? ts.ScriptTarget.Latest,
  );

  const classNode = findClassByName(sourceFile, className);

  if (classNode === undefined) {
    return null;
  }

  const sloc = countSLOC(source, classNode);
  const publicMethodCount = countPublicMethods(classNode);
  const maxCyclomatic = computeMaxCyclomaticComplexity(classNode);

  const metrics: CoreNodeMetricValue[] = [];

  for (const boundary of boundaries) {
    const rawValue =
      boundary.name === "sloc"
        ? sloc
        : boundary.name === "public-method-count"
          ? publicMethodCount
          : maxCyclomatic;

    metrics.push({
      name: boundary.name as CoreNodeMetricValue["name"],
      value: rawValue,
      ideal: boundary.ideal,
      max: boundary.max,
      status: getMetricStatus(rawValue, boundary.ideal, boundary.max),
    });
  }

  return {
    id: "",
    role: "business-core-service",
    target: `${sourcePath}::${className}`,
    filePath: sourcePath,
    className,
    metrics,
  };
}

export function measureCoreNode(
  sourcePath: string,
  source: string,
  target: string,
  boundaries: Array<{
    name: string;
    ideal: number;
    max: number;
  }>,
): CoreNodeMeasurement | null {
  const parsed = parseCoreNodeTarget(target);
  if (parsed === undefined) return null;

  return extractClassMetrics(sourcePath, source, parsed.className, boundaries);
}
