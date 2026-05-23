import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
export async function createExtractor(options: ExtractorOptions): Promise<{
  extractImports(file: string, source: string): DependencyEdge[];
  resolveModule(specifier: string, containingFile: string): string | null;
}> {
  const projectDir = options.projectDir;
  const compilerOptions = await loadCompilerOptions(options);
  const compilerHost = ts.createCompilerHost(compilerOptions, true);

  // Discover workspace packages for custom resolution. ts.ModuleResolutionKind.Bundler
  // ignores `paths` config — so we resolve `@stele/*` specifiers manually by walking
  // the packages directory and matching against the source files we know exist.
  const workspacePackages = await discoverWorkspacePackages(options.projectDir);

  // Minimal resolver cache for module resolution
  const resolverCache = new Map<string, string | null>();

  const resolveModule = (specifier: string, containingFile: string): string | null => {
    const cacheKey = `${specifier}@@${containingFile}`;
    const cached = resolverCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Fast path: resolve workspace package imports directly (e.g. "@stele/core/foo.ts")
    const direct = resolveWorkspaceSpecifier(specifier, containingFile, projectDir, workspacePackages);
    if (direct !== null) {
      resolverCache.set(cacheKey, direct);
      return direct;
    }

    // Fallback: TypeScript built-in resolution
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
 * Discover workspace packages by scanning a `packages/` directory and reading
 * each package.json for name + main entry. Returns a map of package-name → src
 * directory path.
 */
/**
 * Resolve a workspace package specifier (e.g. "@stele/core" or "@stele/core/something.ts")
 * to an absolute file path by walking the packages directory.
 *
 * This bypasses TypeScript's built-in resolution (which ignores paths with Bundler mode)
 * and resolves directly against source files.
 *
 * Also handles relative imports by resolving them relative to the containing file.
 */
function resolveWorkspaceSpecifier(
  specifier: string,
  containingFile: string,
  projectDir: string,
  packages: Map<string, string>,
): string | null {
  // Relative imports: resolve relative to containing file's directory
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const dir = containingFile.includes("/")
      ? containingFile.substring(0, containingFile.lastIndexOf("/") + 1)
      : containingFile.substring(0, containingFile.lastIndexOf("\\") + 1);
    const base = join(dir, specifier);

    // Exact match first
    if (ts.sys.fileExists(base)) {
      return base;
    }

    // ESM TypeScript uses .js in import specifiers but the actual files are .ts.
    // Strip .js extension and try .ts (and other extensions).
    const stripped = base.replace(/\.(js|jsx|tsx|ts|mjs|cjs)$/, "");

    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const candidate = stripped + ext;
      if (ts.sys.fileExists(candidate)) {
        return candidate;
      }
    }

    // Try as directory with index
    for (const index of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
      const candidate = join(stripped, index);
      if (ts.sys.fileExists(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  // Exact match: "@stele/core" -> packages/core/src/index.ts
  if (packages.has(specifier)) {
    const srcDir = packages.get(specifier)!;
    // Try index.ts first, then index.js
    for (const ext of ["index.ts", "index.js"]) {
      const candidate = join(srcDir, ext);
      if (ts.sys.fileExists(candidate)) {
        return candidate;
      }
    }
    // Fall back to package.json main / exports field
    const pkgJsonPath = join(srcDir, "..", "package.json");
    if (ts.sys.fileExists(pkgJsonPath)) {
      const content = ts.sys.readFile(pkgJsonPath);
      if (content !== undefined) {
        try {
          const pkg = JSON.parse(content);
          // Check "exports" field first (ESM packages)
          if (typeof pkg.exports === "object" && pkg.exports !== null) {
            const firstKey = Object.keys(pkg.exports)[0]!;
            const mainExport = pkg.exports["."] ?? pkg.exports[firstKey];
            if (typeof mainExport === "string") {
              const candidate = join(srcDir, "..", mainExport);
              if (ts.sys.fileExists(candidate)) {
                return candidate;
              }
            } else if (typeof mainExport === "object" && mainExport.types !== undefined) {
              const candidate = join(srcDir, "..", mainExport.types);
              if (ts.sys.fileExists(candidate)) {
                return candidate;
              }
            }
          }
          // Then "main" field
          if (typeof pkg.main === "string") {
            const candidate = join(srcDir, "..", pkg.main);
            if (ts.sys.fileExists(candidate)) {
              return candidate;
            }
          }
          // Then "types" field
          if (typeof pkg.types === "string") {
            const candidate = join(srcDir, "..", pkg.types);
            if (ts.sys.fileExists(candidate)) {
              return candidate;
            }
          }
        } catch { /* ignore */ }
      }
    }
    return null;
  }

  // Subpath match: "@stele/core/something/foo" -> packages/core/src/something/foo
  const slashIdx = specifier.indexOf("/");
  if (slashIdx !== -1) {
    const pkgName = specifier.substring(0, slashIdx);
    const subPath = specifier.substring(slashIdx + 1);
    if (packages.has(pkgName)) {
      const srcDir = packages.get(pkgName)!;
      // Try direct subpath resolution with extensions
      for (const ext of ["", ".ts", ".js", ".tsx", ".jsx"]) {
        const candidate = join(srcDir, subPath + ext);
        if (ts.sys.fileExists(candidate)) {
          return candidate;
        }
      }
      // Try as directory with index
      for (const index of ["index.ts", "index.js"]) {
        const candidate = join(srcDir, subPath, index);
        if (ts.sys.fileExists(candidate)) {
          return candidate;
        }
      }
      // Try package.json exports for subpath
      const pkgJsonPath = join(srcDir, "..", "package.json");
      if (ts.sys.fileExists(pkgJsonPath)) {
        const content = ts.sys.readFile(pkgJsonPath);
        if (content !== undefined) {
          try {
            const pkg = JSON.parse(content);
            if (typeof pkg.exports === "object" && pkg.exports !== null) {
              // Check for exact export match or wildcard pattern
              const exportKey = "./" + subPath;
              if (exportKey in pkg.exports) {
                const exportVal = pkg.exports[exportKey];
                if (typeof exportVal === "string") {
                  const candidate = join(srcDir, "..", exportVal);
                  if (ts.sys.fileExists(candidate)) {
                    return candidate;
                  }
                }
              }
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  return null;
}


async function discoverWorkspacePackages(projectDir: string): Promise<Map<string, string>> {
  // Walk up to find monorepo root (where packages/ directory lives)
  // projectDir might be packages/cli, so we need to find the repo root
  let current = resolve(projectDir);
  let packagesDir: string | null = null;

  while (true) {
    if (ts.sys.directoryExists(join(current, "packages"))) {
      packagesDir = join(current, "packages");
      break;
    }
    const parent = join(current, "..");
    if (parent === current) break; // reached root
    current = parent;
  }

  const pkgMap = new Map<string, string>();
  if (!packagesDir) return pkgMap;

  try {
    const entries = await readdir(packagesDir);
    for (const entry of entries) {
      const pkgJsonPath = join(packagesDir, entry, "package.json");
      try {
        const content = await readFile(pkgJsonPath, "utf8");
        const pkg = JSON.parse(content);
        const name = pkg.name;
        if (typeof name === "string") {
          // Use src/ as the source root; fall back to dist/ for built packages
          const srcDir = join(packagesDir, entry, "src");
          pkgMap.set(name, srcDir);
        }
      } catch {
        // Not a valid package.json — skip
        continue;
      }
    }
  } catch {
    // No packages/ directory — not a monorepo
  }

  return pkgMap;
}


/**
 * Build TypeScript `paths` mappings from workspace packages so that `@stele/*`
 * imports resolve correctly even without a tsconfig with explicit paths.
 */
function buildWorkspacePaths(
  projectDir: string,
  packages: Map<string, string>,
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};

  for (const [name, srcDir] of packages) {
    // Map both the package root and subpath imports
    // e.g. "@stele/core" → ["packages/core/src/index.ts"]
    //      "@stele/core/*" → ["packages/core/src/*"]
    const relativeSrc = srcDir.slice(projectDir.length).replace(/\\/g, "/");
    // Strip trailing /src for cleaner paths config
    const relativePkg = relativeSrc.replace(/\/src$/, "");

    paths[name] = [relativePkg + "/src/index.ts", relativePkg + "/src/index.js"];
    paths[name + "/*"] = [relativePkg + "/src/*"];
  }

  return paths;
}

/**
 * Load TypeScript compiler options from tsconfig or use sensible defaults.
 *
 * For monorepos, discovers workspace packages and constructs path mappings so
 * that cross-package imports (e.g. `@stele/core`) resolve correctly.
 */
async function loadCompilerOptions(options: ExtractorOptions): Promise<ts.CompilerOptions> {
  if (options.tsconfigPath !== undefined) {
    const configResult = ts.readConfigFile(options.tsconfigPath, ts.sys.readFile);
    if (configResult.config !== undefined && configResult.config.compilerOptions !== undefined) {
      const existing = configResult.config.compilerOptions as ts.CompilerOptions;
      // If the tsconfig already has paths, use as-is
      if (existing.paths && Object.keys(existing.paths).length > 0) {
        return existing;
      }
      // Otherwise, augment with workspace path mappings
      const packages = await discoverWorkspacePackages(options.projectDir);
      if (packages.size > 0) {
        return {
          ...existing,
          baseUrl: options.projectDir,
          paths: buildWorkspacePaths(options.projectDir, packages),
        };
      }
      return existing;
    }
  }

  // No tsconfig — discover workspace packages for path mappings
  const packages = await discoverWorkspacePackages(options.projectDir);
  const paths = packages.size > 0 ? buildWorkspacePaths(options.projectDir, packages) : {};

  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    baseUrl: options.projectDir,
    rootDir: options.projectDir,
    paths,
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
