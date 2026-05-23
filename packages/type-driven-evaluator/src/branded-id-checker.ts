import * as ts from "typescript";
import { dirname, resolve } from "node:path";
import { minimatch } from "minimatch";
import type { BrandedIdDeclaration, BrandedIdViolation, BrandedIdCheckOptions } from "./types.js";

// Round 4 F-A-04: removed dead `_RULE_ID = "typedriven.shape.branded-id"`
// constant. The branded-id violations emitted by this module carry their
// rule_id at the call site; the constant was never referenced. Reviewer F's
// audit confirmed the hollow attribute and recommended deletion.

/** Parse "path/to/file.ts::TypeName" into { filePath, typeName }. */
function parseTypeTarget(
  typeTarget: string,
): { filePath: string; typeName: string } {
  const parts = typeTarget.split("::");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new Error(
      `Invalid typeTarget format: "${typeTarget}". Expected "path/to/file.ts::TypeName"`,
    );
  }
  return { filePath: parts[0].trim(), typeName: parts[1].trim() };
}

/**
 * Given a branded type name (e.g. "InvoiceId"), produce the expected field name
 * suffix pattern. "InvoiceId" -> "invoiceId", "CustomerId" -> "customerId".
 */
function deriveFieldNameSuffix(typeName: string): string {
  if (/[A-Z].*Id$/.test(typeName)) {
    const base = typeName;
    return base[0].toLowerCase() + base.slice(1);
  }
  return typeName.toLowerCase();
}

/** Normalize a path to forward slashes for consistent glob matching. */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Check if a ts.Type is the primitive string type.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function isPrimitiveString(type: ts.Type, _checker: ts.TypeChecker): boolean {
  // The intrinsic `string` type has TypeFlags.String (value 4)
  if (type.flags === ts.TypeFlags.String) return true;

  // Also check via symbol name (fallback for branded/intersection types
  // that resolve to string)
  const symbol = type.symbol;
  if (symbol && symbol.name === "String") {
    // Could be the String constructor type — check if it's the primitive
    return true;
  }

  return false;
}

/**
 * Find a type alias or interface declaration by name in a source file.
 */
function findTypeDeclaration(
  sourceFile: ts.SourceFile,
  typeName: string,
): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  function search(node: ts.Node): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === typeName
    ) {
      return node;
    }
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === typeName
    ) {
      return node;
    }
    let found: ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined;
    ts.forEachChild(node, (child) => {
      if (!found) found = search(child);
    });
    return found;
  }
  return search(sourceFile);
}

/**
 * Collect all source files that match the entity scope glob.
 */
function getScopeFiles(
  entityScope: string,
  allSourceFiles: ts.SourceFile[],
  projectDir: string,
): ts.SourceFile[] {
  const posixProjectDir = toPosixPath(projectDir);

  return allSourceFiles.filter((sf) => {
    const posixFile = toPosixPath(sf.fileName);
    // Compute relative path: strip project dir prefix, then strip leading slash
    const relativePath = posixFile.startsWith(posixProjectDir)
      ? posixFile.slice(posixProjectDir.length).replace(/^\//, "")
      : posixFile;

    return (
      minimatch(relativePath, entityScope) ||
      minimatch(posixFile, entityScope)
    );
  });
}

/**
 * Visitor that finds fields and parameters with `string` type where
 * a branded ID type is expected.
 */
function collectStringViolations(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  expectedFieldName: string,
  typeName: string,
  brandedType: ts.Type,
): BrandedIdViolation[] {
  const violations: BrandedIdViolation[] = [];

  function visit(n: ts.Node): void {
    // Check class property declarations
    if (ts.isPropertyDeclaration(n)) {
      const nameNode = n.name;
      if (!ts.isIdentifier(nameNode)) return;

      const fieldName = nameNode.text;
      if (fieldName === expectedFieldName || fieldName.endsWith(expectedFieldName)) {
        // Check the type
        if (n.type) {
          const fieldType = checker.getTypeFromTypeNode(n.type);
          if (isPrimitiveString(fieldType, checker)) {
            const pos = n.name.getStart(sourceFile);
            const lineInfo = sourceFile.getLineAndCharacterOfPosition(pos);
            violations.push({
              file: sourceFile.fileName,
              line: lineInfo.line + 1,
              column: lineInfo.character + 1,
              message: `Field "${fieldName}" should use branded type "${typeName}" instead of \`string\``,
              fix: `Change type of "${fieldName}" from \`string\` to \`${typeName}\``,
            });
          } else {
            // Check if it's actually the branded type (no violation if correct)
            const isMatch = checker.isTypeAssignableTo(fieldType, brandedType);
            if (isMatch) {
              // Correct usage, no violation
            }
          }
        }
      }
    }

    // Check function/method parameters
    if (ts.isParameter(n)) {
      const nameNode = n.name;
      if (!ts.isIdentifier(nameNode)) return;

      const paramName = nameNode.text;
      if (paramName === expectedFieldName || paramName.endsWith(expectedFieldName)) {
        if (n.type) {
          const paramType = checker.getTypeFromTypeNode(n.type);
          if (isPrimitiveString(paramType, checker)) {
            const pos = n.name.getStart(sourceFile);
            const lineInfo = sourceFile.getLineAndCharacterOfPosition(pos);
            violations.push({
              file: sourceFile.fileName,
              line: lineInfo.line + 1,
              column: lineInfo.character + 1,
              message: `Parameter "${paramName}" should use branded type "${typeName}" instead of \`string\``,
              fix: `Change type of "${paramName}" from \`string\` to \`${typeName}\``,
            });
          }
        }
      }
    }

    // Check variable declarations with type annotation
    if (ts.isVariableDeclaration(n) && n.name && ts.isIdentifier(n.name)) {
      const varName = n.name.text;
      if (n.type && (varName === expectedFieldName || varName.endsWith(expectedFieldName))) {
        const varType = checker.getTypeFromTypeNode(n.type);
        if (isPrimitiveString(varType, checker)) {
          const pos = n.name.getStart(sourceFile);
          const lineInfo = sourceFile.getLineAndCharacterOfPosition(pos);
          violations.push({
            file: sourceFile.fileName,
            line: lineInfo.line + 1,
            column: lineInfo.character + 1,
            message: `Variable "${varName}" should use branded type "${typeName}" instead of \`string\``,
            fix: `Change type of "${varName}" from \`string\` to \`${typeName}\``,
          });
        }
      }
    }

    // Check function return types
    if (ts.isFunctionDeclaration(n) && n.name && ts.isIdentifier(n.name)) {
      // A function named "get<ExpectedField>" returning string should return branded type
      const funcName = n.name.text;
      if (funcName.startsWith("get" + expectedFieldName.charAt(0).toUpperCase() + expectedFieldName.slice(1))) {
        if (n.type) {
          const returnType = checker.getTypeFromTypeNode(n.type);
          if (isPrimitiveString(returnType, checker)) {
            const pos = n.name.getStart(sourceFile);
            const lineInfo = sourceFile.getLineAndCharacterOfPosition(pos);
            violations.push({
              file: sourceFile.fileName,
              line: lineInfo.line + 1,
              column: lineInfo.character + 1,
              message: `Function "${funcName}" should return branded type "${typeName}" instead of \`string\``,
              fix: `Change return type of "${funcName}" from \`string\` to \`${typeName}\``,
            });
          }
        }
      }
    }

    ts.forEachChild(n, visit);
  }

  visit(node);
  return violations;
}

/** Build a ts.Program from the tsconfig, including the branded type targets. */
function buildProgram(
  projectDir: string,
  tsconfigPath: string,
  extraRootNames: string[] = [],
): ts.Program {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (!configFile.config) {
    throw new Error(`Failed to read tsconfig: ${tsconfigPath}`);
  }

  const configDir = dirname(tsconfigPath);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    configDir,
  ) as ts.ParsedCommandLine & { fileNames: string[] };

  const rootNames = Array.from(new Set([...parsedConfig.fileNames, ...extraRootNames]));

  return ts.createProgram({
    rootNames,
    options: parsedConfig.options,
  });
}

/**
 * Run the branded ID check for a single declaration.
 */
function checkDeclaration(
  declaration: BrandedIdDeclaration,
  program: ts.Program,
  checker: ts.TypeChecker,
  projectDir: string,
): BrandedIdViolation[] {
  const violations: BrandedIdViolation[] = [];

  // Parse the type target
  let filePath: string;
  let typeName: string;
  try {
    const parsed = parseTypeTarget(declaration.typeTarget);
    filePath = parsed.filePath;
    typeName = parsed.typeName;
  } catch {
    violations.push({
      file: declaration.typeTarget,
      line: 0,
      column: 0,
      message: `Failed to parse typeTarget: ${declaration.typeTarget}`,
      fix: "Ensure typeTarget is in 'file::Type' format",
    });
    return violations;
  }

  // Find the source file for the branded type
  const typeSourceFile = program.getSourceFile(filePath);
  if (!typeSourceFile) {
    violations.push({
      file: filePath,
      line: 0,
      column: 0,
      message: `Source file for branded type "${typeName}" not found: ${filePath}`,
      fix: `Ensure the file path "${filePath}" exists and is included in the tsconfig`,
    });
    return violations;
  }

  // Find the type declaration
  const typeDecl = findTypeDeclaration(typeSourceFile, typeName);
  if (!typeDecl) {
    violations.push({
      file: filePath,
      line: 0,
      column: 0,
      message: `Type "${typeName}" not found in ${filePath}`,
      fix: `Ensure type "${typeName}" is declared in "${filePath}"`,
    });
    return violations;
  }

  // Get the branded type via TypeChecker
  const brandedType = checker.getTypeAtLocation(typeDecl);

  // If no entityScope, advisory only: skip enforcement
  if (!declaration.entityScope) {
    // Advisory mode: no violations reported, but we could log warnings
    return violations;
  }

  // Find files in scope
  const allFiles = program.getSourceFiles();
  const scopeFiles = getScopeFiles(declaration.entityScope, Array.from(allFiles), projectDir);

  if (scopeFiles.length === 0) {
    return violations;
  }

  // Derive the expected field name
  const expectedFieldName = deriveFieldNameSuffix(typeName);

  // Check each scope file
  for (const sf of scopeFiles) {
    // Skip the type definition file itself
    if (sf.fileName === filePath) continue;

    const fileViolations = collectStringViolations(
      sf,
      sf,
      checker,
      expectedFieldName,
      typeName,
      brandedType,
    );
    violations.push(...fileViolations);
  }

  return violations;
}

/**
 * Check that declared entity scopes use branded ID types instead of string.
 */
export function checkBrandedIds(
  options: BrandedIdCheckOptions,
): BrandedIdViolation[] {
  if (options.declarations.length === 0) {
    return [];
  }

  const tsconfigPath = options.tsconfigPath ?? resolve(options.projectDir, "tsconfig.json");

  // Pre-collect target file paths so the program includes them even if the
  // tsconfig include patterns don't.
  const extraFiles: string[] = [];
  for (const decl of options.declarations) {
    try {
      const parsed = parseTypeTarget(decl.typeTarget);
      extraFiles.push(parsed.filePath);
    } catch {
      // skip
    }
  }

  const program = buildProgram(options.projectDir, tsconfigPath, extraFiles);
  const checker = program.getTypeChecker();

  const allViolations: BrandedIdViolation[] = [];
  for (const declaration of options.declarations) {
    const violations = checkDeclaration(declaration, program, checker, options.projectDir);
    allViolations.push(...violations);
  }

  return allViolations;
}
