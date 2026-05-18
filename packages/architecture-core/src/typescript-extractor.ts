import * as ts from "typescript";
import type { DependencyEdge, DependencyImportKind } from "./types.js";

export interface ExtractorOptions {
  projectDir: string;
  tsconfigPath?: string;
}

/**
 * Create a TypeScript import extractor.
 *
 * Uses the TypeScript compiler API to parse source files and extract
 * dependency edges (imports, exports, dynamic imports, require calls).
 */
export function createExtractor(options: ExtractorOptions): {
  extractImports(file: string, source: string): DependencyEdge[];
  resolveModule(specifier: string, containingFile: string): string | null;
} {
  const projectDir = options.projectDir;
  const compilerOptions = loadCompilerOptions(options);
  const compilerHost = ts.createCompilerHost(compilerOptions, true);

  // Minimal resolver cache for module resolution
  const resolverCache = new Map<string, string | null>();

  const resolveModule = (specifier: string, containingFile: string): string | null => {
    const cacheKey = `${specifier}@@${containingFile}`;
    const cached = resolverCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const result = ts.resolveModuleName(specifier, containingFile, compilerOptions, compilerHost);
    const resolved = result.resolvedModule?.resolvedFileName ?? null;
    resolverCache.set(cacheKey, resolved);
    return resolved;
  };

  const extractImports = (file: string, source: string): DependencyEdge[] => {
    const sourceFile = ts.createSourceFile(
      file,
      source,
      compilerOptions.target ?? ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
    );

    const edges: DependencyEdge[] = [];
    const seen = new Set<string>();

    const visit = (node: ts.Node): void => {
      // Static import: import ... from "x"
      if (ts.isImportDeclaration(node) && node.moduleSpecifier !== undefined) {
        const specifierText = extractLiteralText(node.moduleSpecifier);
        if (specifierText !== null) {
          const position = node.moduleSpecifier.getStart(sourceFile);
          const lineInfo = ts.getLineAndCharacterOfPosition(sourceFile, position);
          const resolved = resolveModule(specifierText, file);
          if (resolved !== null && !seen.has(`${specifierText}@${resolved}`)) {
            seen.add(`${specifierText}@${resolved}`);
            edges.push({
              fromModule: "",
              toModule: "",
              fromFile: file,
              toFile: resolved,
              specifier: specifierText,
              importKind: "static-import" as DependencyImportKind,
              line: lineInfo.line + 1,
              column: lineInfo.character + 1,
            });
          }
        }
      }

      // Static export: export ... from "x"
      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        const specifierText = extractLiteralText(node.moduleSpecifier);
        if (specifierText !== null) {
          const position = node.moduleSpecifier.getStart(sourceFile);
          const lineInfo = ts.getLineAndCharacterOfPosition(sourceFile, position);
          const resolved = resolveModule(specifierText, file);
          if (resolved !== null && !seen.has(`${specifierText}@${resolved}`)) {
            seen.add(`${specifierText}@${resolved}`);
            edges.push({
              fromModule: "",
              toModule: "",
              fromFile: file,
              toFile: resolved,
              specifier: specifierText,
              importKind: "export-from" as DependencyImportKind,
              line: lineInfo.line + 1,
              column: lineInfo.character + 1,
            });
          }
        }
      }

      // Dynamic import: import("x")
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "import") {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          const specifierText = arg.text;
          const position = arg.getStart(sourceFile);
          const lineInfo = ts.getLineAndCharacterOfPosition(sourceFile, position);
          const resolved = resolveModule(specifierText, file);
          if (resolved !== null && !seen.has(`${specifierText}@${resolved}`)) {
            seen.add(`${specifierText}@${resolved}`);
            edges.push({
              fromModule: "",
              toModule: "",
              fromFile: file,
              toFile: resolved,
              specifier: specifierText,
              importKind: "dynamic-import" as DependencyImportKind,
              line: lineInfo.line + 1,
              column: lineInfo.character + 1,
            });
          }
        }
      }

      // Require call: require("x")
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          const specifierText = arg.text;
          const position = arg.getStart(sourceFile);
          const lineInfo = ts.getLineAndCharacterOfPosition(sourceFile, position);
          const resolved = resolveModule(specifierText, file);
          if (resolved !== null && !seen.has(`${specifierText}@${resolved}`)) {
            seen.add(`${specifierText}@${resolved}`);
            edges.push({
              fromModule: "",
              toModule: "",
              fromFile: file,
              toFile: resolved,
              specifier: specifierText,
              importKind: "require-call" as DependencyImportKind,
              line: lineInfo.line + 1,
              column: lineInfo.character + 1,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return edges;
  };

  return { extractImports, resolveModule };
}

/**
 * Load TypeScript compiler options from tsconfig or use sensible defaults.
 */
function loadCompilerOptions(options: ExtractorOptions): ts.CompilerOptions {
  if (options.tsconfigPath !== undefined) {
    const configResult = ts.readConfigFile(options.tsconfigPath, ts.sys.readFile);
    if (configResult.config !== undefined && configResult.config.compilerOptions !== undefined) {
      return configResult.config.compilerOptions as ts.CompilerOptions;
    }
  }

  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    baseUrl: options.projectDir,
    rootDir: options.projectDir,
    paths: {},
  };
}

/**
 * Extract the literal text from a module specifier (string literal).
 */
function extractLiteralText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  return null;
}
