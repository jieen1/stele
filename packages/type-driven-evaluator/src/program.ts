import * as ts from "typescript";
import { resolve, dirname, normalize } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShapeProgramOptions {
  projectDir: string;
  tsconfigPath?: string;
  sourceFiles?: string[];
}

export interface ShapeProgram {
  program: ts.Program;
  typeChecker: ts.TypeChecker;
  parsedCommandLine: ts.ParsedCommandLine;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Cache keyed by normalized (projectDir, tsconfigPath) pair.
 * Avoids repeated ts.createProgram calls which are expensive.
 */
const programCache = new Map<string, ShapeProgram>();

function cacheKey(options: ShapeProgramOptions): string {
  const configPart = options.tsconfigPath ? normalize(options.tsconfigPath) : "none";
  return `${normalize(options.projectDir)}|${configPart}`;
}

/** Clear the cache. Useful in tests or when tsconfig changes on disk. */
export function clearProgramCache(): void {
  programCache.clear();
}

// ---------------------------------------------------------------------------
// Tsconfig resolution
// ---------------------------------------------------------------------------

/**
 * Parse a tsconfig file using the TypeScript compiler API.
 * Returns the parsed command line, or throws if the file cannot be read.
 */
function parseTsconfig(absolutePath: string): ts.ParsedCommandLine {
  const readResult = ts.readConfigFile(absolutePath, ts.sys.readFile);

  if (readResult.error && !readResult.config) {
    throw new Error(
      `Failed to read tsconfig at ${absolutePath}: ${readResult.error.messageText ?? "unknown error"}`,
    );
  }

  const configDir = dirname(absolutePath);
  return ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    configDir,
  );
}

/**
 * Find a tsconfig.json starting from a directory and walking up to the fs root.
 * Returns the resolved absolute path or undefined.
 */
function findTsconfig(dir: string): string | undefined {
  let current = resolve(dir);
  const seen = new Set<string>();

  while (true) {
    if (seen.has(current)) break;
    seen.add(current);

    const candidate = resolve(current, "tsconfig.json");
    if (ts.sys.fileExists(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a TypeScript program for shape checking.
 *
 * Caches the result per (projectDir, tsconfigPath) pair so repeated calls
 * within the same session reuse the compiled program instead of re-parsing
 * the entire project tree.
 */
export function createShapeProgram(
  options: ShapeProgramOptions,
): ShapeProgram {
  const cached = programCache.get(cacheKey(options));
  if (cached) {
    return cached;
  }

  // Resolve tsconfig path
  const tsconfigPath =
    options.tsconfigPath
      ? resolve(options.projectDir, options.tsconfigPath)
      : findTsconfig(options.projectDir);

  let parsedCommandLine: ts.ParsedCommandLine;

  if (tsconfigPath) {
    parsedCommandLine = parseTsconfig(tsconfigPath);
  } else {
    // Fallback: minimal config with the project directory as base.
    parsedCommandLine = ts.parseJsonConfigFileContent(
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ts.sys,
      options.projectDir,
    );
  }

  // Merge optional source files into file names
  const rootNames = [
    ...parsedCommandLine.fileNames,
    ...(options.sourceFiles
      ? options.sourceFiles.map((f) => resolve(options.projectDir, f))
      : []),
  ];

  const program = ts.createProgram({
    rootNames,
    options: parsedCommandLine.options,
  });

  const result: ShapeProgram = {
    program,
    typeChecker: program.getTypeChecker(),
    parsedCommandLine,
  };

  programCache.set(cacheKey(options), result);
  return result;
}

// ---------------------------------------------------------------------------
// Source file lookup
// ---------------------------------------------------------------------------

/**
 * Find a source file in the program by path.
 *
 * Tries multiple path variants: the raw input, resolved against projectDir,
 * and normalized forms. This handles both relative and absolute paths.
 */
export function findSourceFile(
  program: ts.Program,
  filePath: string,
  projectDir: string,
): ts.SourceFile | undefined {
  const candidates = [
    filePath,
    normalize(filePath),
    resolve(projectDir, filePath),
    normalize(resolve(projectDir, filePath)),
  ];

  // Also try resolving the raw path as absolute
  if (!filePath.startsWith("/") && !/^[a-z]:/i.test(filePath)) {
    candidates.push(resolve(filePath));
  }

  for (const candidate of candidates) {
    const sf = program.getSourceFile(candidate);
    if (sf) return sf;
  }

  // Fallback: scan all source files for a matching suffix
  const normalizedCandidate = normalize(filePath).replace(/\\/g, "/");
  for (const sf of program.getSourceFiles()) {
    const sfPath = sf.fileName.replace(/\\/g, "/");
    if (
      sfPath === normalizedCandidate ||
      sfPath.endsWith("/" + normalizedCandidate) ||
      sfPath.endsWith(normalizedCandidate)
    ) {
      return sf;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Declaration lookup
// ---------------------------------------------------------------------------

/**
 * Find a named declaration (class, interface, enum, type alias, function, or variable)
 * at the top level of a source file.
 */
export function findNamedDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.NamedDeclaration | undefined {
  for (const stmt of sourceFile.statements) {
    const decl = extractNamedDeclaration(stmt, name);
    if (decl) return decl;
  }
  return undefined;
}

/**
 * Extract a NamedDeclaration from a single statement if its name matches.
 */
function extractNamedDeclaration(
  stmt: ts.Statement,
  name: string,
): ts.NamedDeclaration | undefined {
  let node: ts.NamedDeclaration | undefined;

  if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) {
    node = stmt;
  } else if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) {
    node = stmt;
  } else if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) {
    node = stmt;
  } else if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) {
    node = stmt;
  } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
    node = stmt;
  } else if (ts.isVariableStatement(stmt)) {
    // Handle `export const foo = ...`
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) {
        node = decl;
        break;
      }
    }
  }

  return node;
}
