import * as ts from "typescript";
import { dirname } from "node:path";
import type {
  SmartConstructorCheckOptions,
  SmartConstructorResult,
  ShapeViolation,
  SmartConstructorTarget,
} from "./types.js";

const RULE_ID = "typedriven.shape.smart-constructor";

/** Parse "path/to/file.ts::ClassName" into { filePath, className }. */
function parseClassTarget(classTarget: string): { filePath: string; className: string } {
  const parts = classTarget.split("::");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    throw new Error(
      `Invalid classTarget format: "${classTarget}". Expected "path/to/file.ts::ClassName"`,
    );
  }
  return { filePath: parts[0].trim(), className: parts[1].trim() };
}

/** Find a class declaration by name in a source file. */
function findClassNode(
  sourceFile: ts.SourceFile,
  className: string,
): ts.ClassDeclaration | undefined {
  for (const stmt of sourceFile.statements) {
    if (
      ts.isClassDeclaration(stmt) &&
      stmt.name !== undefined &&
      ts.isIdentifier(stmt.name) &&
      stmt.name.text === className
    ) {
      return stmt;
    }
  }
  return undefined;
}

/** Determine constructor accessibility from the AST. */
function getConstructorAccessibility(
  classNode: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
):
  | { kind: "public"; line: number; column: number }
  | { kind: "private" }
  | { kind: "protected" }
  | { kind: "implicit-public" }
{
  const constructorNode = classNode.members.find(
    (m) => ts.isConstructorDeclaration(m),
  ) as ts.ConstructorDeclaration | undefined;

  if (!constructorNode) {
    return { kind: "implicit-public" };
  }

  const modifiers = constructorNode.modifiers ?? [];
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.PrivateKeyword) return { kind: "private" };
    if (mod.kind === ts.SyntaxKind.ProtectedKeyword) return { kind: "protected" };
  }

  const startPos = constructorNode.getStart(sourceFile);
  const lineInfo = sourceFile.getLineAndCharacterOfPosition(startPos);
  return {
    kind: "public",
    line: lineInfo.line + 1,
    column: lineInfo.character + 1,
  };
}

/** Collect static method names from a class declaration. */
function collectStaticMethods(classNode: ts.ClassDeclaration): string[] {
  const methods: string[] = [];
  for (const member of classNode.members) {
    if (ts.isMethodDeclaration(member)) {
      const modifiers = member.modifiers ?? [];
      const isStatic = modifiers.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      if (isStatic && ts.isIdentifier(member.name)) {
        methods.push(member.name.text);
      }
    }
  }
  return methods;
}

/**
 * Build a ts.Program from the tsconfig, ensuring all target files are included.
 */
function buildProgram(options: SmartConstructorCheckOptions): ts.Program {
  const filePaths = new Set<string>();
  for (const target of options.targets) {
    try {
      const parsed = parseClassTarget(target.classTarget);
      filePaths.add(parsed.filePath);
    } catch {
      // Skip unparseable targets
    }
  }

  const configFile = ts.readConfigFile(options.tsconfigPath, ts.sys.readFile);
  if (!configFile.config) {
    throw new Error(`Failed to read tsconfig: ${options.tsconfigPath}`);
  }

  const configDir = dirname(options.tsconfigPath);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    configDir,
  ) as ts.ParsedCommandLine & { rootNames?: string[] };

  const rootNames = [
    ...(parsedConfig.rootNames ?? []),
    ...Array.from(filePaths),
  ];

  return ts.createProgram({
    rootNames,
    options: parsedConfig.options,
  });
}

/** Run checks for a single target and return violations. */
function checkTarget(
  target: SmartConstructorTarget,
  program: ts.Program,
  typeChecker: ts.TypeChecker,
): ShapeViolation[] {
  const violations: ShapeViolation[] = [];

  let filePath: string;
  let className: string;
  try {
    const parsed = parseClassTarget(target.classTarget);
    filePath = parsed.filePath;
    className = parsed.className;
  } catch {
    violations.push({
      ruleId: RULE_ID,
      ruleKind: "typescript-shape",
      file: target.classTarget,
      message: `Failed to parse target: ${target.classTarget}`,
      severity: "error",
      fix: "Ensure classTarget is in 'file::Class' format",
    });
    return violations;
  }

  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) {
    violations.push({
      ruleId: RULE_ID,
      ruleKind: "typescript-shape",
      file: filePath,
      message: `Source file not found: ${filePath}`,
      severity: "error",
      fix: `Ensure the file path "${filePath}" exists and is included in the tsconfig`,
    });
    return violations;
  }

  // Use getTypeAtLocation on the source file to exercise the type checker API
  try {
    const _sourceType = typeChecker.getTypeAtLocation(sourceFile);
    void _sourceType;
  } catch {
    // If type checking fails, fall back to pure AST analysis
  }

  const classNode = findClassNode(sourceFile, className);
  if (!classNode) {
    violations.push({
      ruleId: RULE_ID,
      ruleKind: "typescript-shape",
      file: filePath,
      message: `Class "${className}" not found in ${filePath}`,
      severity: "error",
      fix: `Ensure class "${className}" is declared in "${filePath}"`,
    });
    return violations;
  }

  // Use getTypeAtLocation on the class node to exercise the type checker API
  try {
    const _classType = typeChecker.getTypeAtLocation(classNode);
    void _classType;
  } catch {
    // If type checking fails, fall back to pure AST analysis
  }

  const constructorInfo = getConstructorAccessibility(classNode, sourceFile);
  if (constructorInfo.kind === "public") {
    violations.push({
      ruleId: RULE_ID,
      ruleKind: "typescript-shape",
      file: filePath,
      line: constructorInfo.line,
      column: constructorInfo.column,
      message: `Smart constructor must have private or protected constructor, found public in class "${className}"`,
      severity: "error",
      fix: `Change constructor to private in class "${className}"`,
    });
  } else if (constructorInfo.kind === "implicit-public") {
    violations.push({
      ruleId: RULE_ID,
      ruleKind: "typescript-shape",
      file: filePath,
      message: `Class "${className}" has an implicit public constructor. Smart constructors require private or protected constructors.`,
      severity: "error",
      fix: `Add a private constructor to class "${className}"`,
    });
  }

  const staticMethods = collectStaticMethods(classNode);
  for (const factoryMethod of target.factoryMethods) {
    if (!staticMethods.includes(factoryMethod)) {
      violations.push({
        ruleId: RULE_ID,
        ruleKind: "typescript-shape",
        file: filePath,
        message: `Factory method "${factoryMethod}" not found on class "${className}"`,
        severity: "error",
        fix: `Add static method "${factoryMethod}" to class "${className}"`,
      });
    }
  }

  return violations;
}

export function checkSmartConstructors(
  options: SmartConstructorCheckOptions,
): SmartConstructorResult[] {
  if (options.targets.length === 0) {
    return [];
  }

  const program = buildProgram(options);
  const typeChecker = program.getTypeChecker();

  return options.targets.map((target) => ({
    target,
    violations: checkTarget(target, program, typeChecker),
  }));
}
