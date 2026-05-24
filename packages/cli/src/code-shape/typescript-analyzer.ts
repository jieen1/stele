// Round 14 P1: TypeScript analyzer for code-shape declarations.
//
// Produces the same {imports, calls, annotations, classes, functions}
// shape as the Python analyzer in `evaluate.ts`, so the downstream
// evaluators (boundary / class-shape / function-shape / type-policy)
// don't need to know which language they're checking.
//
// Uses the TypeScript compiler API (ts.createSourceFile) — no
// tsconfig required; we analyze each file in isolation. That's
// intentional: code-shape is a structural check, not a type-aware
// one. Cross-file type resolution is the job of trace-policy /
// type-state / effect-policy via the @stele/backend-typescript
// CallGraph extractor.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as ts from "typescript";

// Shapes mirror the Python analyzer's output exactly so existing
// downstream evaluators consume them without modification.
export interface TsAnalysisResult {
  files: TsFileAnalysis[];
  errors: TsAnalysisError[];
}

export interface TsAnalysisError {
  path: string;
  summary: string;
  detail?: string;
  line?: number;
  column?: number;
}

export interface TsImport {
  candidates: string[];
  line: number;
  column: number;
}

export interface TsCall {
  name: string;
  line: number;
  column: number;
}

export interface TsAnnotation {
  text: string;
  names: string[];
  line: number;
  column: number;
}

export interface TsField {
  name: string;
  annotation?: string;
  line: number;
  column: number;
}

export interface TsMethod {
  name: string;
  line: number;
  column: number;
  decorators: string[];
  parameters: string[];
  calls: TsCall[];
  annotations: TsAnnotation[];
  fastapiRoute: boolean;
}

export interface TsClass {
  name: string;
  line: number;
  column: number;
  bases: string[];
  fields: TsField[];
  methods: TsMethod[];
  annotations: TsAnnotation[];
}

export interface TsFunction {
  name: string;
  qualname: string;
  line: number;
  column: number;
  decorators: string[];
  parameters: string[];
  calls: TsCall[];
  annotations: TsAnnotation[];
  fastapiRoute: boolean;
}

export interface TsFileAnalysis {
  path: string;
  imports: TsImport[];
  calls: TsCall[];
  annotations: TsAnnotation[];
  classes: TsClass[];
  functions: TsFunction[];
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function isTypeScriptFilePath(filePath: string): boolean {
  // Phase 2 self-dogfooding: hook scripts under
  // `packages/claude-code-plugin/scripts/*.js` are native ESM JS but ship as
  // part of the TypeScript monorepo. Including .js / .mjs / .cjs lets a
  // `(lang typescript)` code-shape declaration target them — the TS compiler
  // API parses JS adequately for the shape checks (calls, classes, fields,
  // imports). Files outside the explicit `(target …)` pattern remain
  // filtered by minimatch upstream.
  return (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".mjs") ||
    filePath.endsWith(".cjs")
  );
}

export async function analyzeTypeScriptFiles(
  projectDir: string,
  files: readonly string[],
): Promise<TsAnalysisResult> {
  const fileAnalyses: TsFileAnalysis[] = [];
  const errors: TsAnalysisError[] = [];

  for (const relativePath of files) {
    const absolutePath = resolve(projectDir, relativePath);
    let source: string;
    try {
      source = await readFile(absolutePath, "utf8");
    } catch (cause) {
      errors.push({
        path: relativePath,
        summary: "Failed to read source file.",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }
    try {
      const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.ES2022,
        /* setParentNodes */ true,
        scriptKindFor(relativePath),
      );
      fileAnalyses.push(analyzeSourceFile(sourceFile, relativePath));
    } catch (cause) {
      errors.push({
        path: relativePath,
        summary: "TypeScript code-shape analysis failed.",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { files: fileAnalyses, errors };
}

function analyzeSourceFile(sourceFile: ts.SourceFile, relativePath: string): TsFileAnalysis {
  const out: TsFileAnalysis = {
    path: relativePath,
    imports: [],
    calls: [],
    annotations: [],
    classes: [],
    functions: [],
  };

  const fileLevelCalls: TsCall[] = [];
  const fileLevelAnnotations: TsAnnotation[] = [];

  // Walk top-level statements.
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const importEntry = readImportDeclaration(sourceFile, statement);
      if (importEntry) out.imports.push(importEntry);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const importEntry = readImportEqualsDeclaration(sourceFile, statement);
      if (importEntry) out.imports.push(importEntry);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      out.classes.push(readClassDeclaration(sourceFile, statement));
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      out.functions.push(readFunctionDeclaration(sourceFile, statement));
    } else if (ts.isVariableStatement(statement)) {
      // Top-level `const x = () => {...}` arrow function; record as
      // function with bestEffort name.
      for (const decl of statement.declarationList.declarations) {
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          if (ts.isIdentifier(decl.name)) {
            out.functions.push(readArrowFunction(sourceFile, decl.name.text, decl.initializer));
          }
        }
      }
    }
  }

  // Collect file-level calls + annotations (anything outside class/function
  // bodies). Cheaper to do a second walk than to thread state through the
  // statement-handler.
  collectFileLevelCallsAndAnnotations(sourceFile, fileLevelCalls, fileLevelAnnotations);
  out.calls = fileLevelCalls;
  out.annotations = fileLevelAnnotations;

  return out;
}

function readImportDeclaration(sourceFile: ts.SourceFile, node: ts.ImportDeclaration): TsImport | null {
  const spec = node.moduleSpecifier;
  if (!ts.isStringLiteral(spec)) {
    return null;
  }
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    candidates: [spec.text],
    line: line + 1,
    column: character + 1,
  };
}

function readImportEqualsDeclaration(
  sourceFile: ts.SourceFile,
  node: ts.ImportEqualsDeclaration,
): TsImport | null {
  if (!ts.isExternalModuleReference(node.moduleReference)) {
    return null;
  }
  const expr = node.moduleReference.expression;
  if (!ts.isStringLiteral(expr)) {
    return null;
  }
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    candidates: [expr.text],
    line: line + 1,
    column: character + 1,
  };
}

function readClassDeclaration(sourceFile: ts.SourceFile, node: ts.ClassDeclaration): TsClass {
  const name = node.name?.text ?? "<anonymous>";
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const bases: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      for (const type of clause.types) {
        bases.push(type.expression.getText(sourceFile));
      }
    }
  }
  const fields: TsField[] = [];
  const methods: TsMethod[] = [];
  const classLevelAnnotations: TsAnnotation[] = [];

  for (const member of node.members) {
    if (ts.isPropertyDeclaration(member) && member.name) {
      fields.push({
        name: member.name.getText(sourceFile),
        annotation: member.type ? member.type.getText(sourceFile) : undefined,
        ...lineColumnOf(sourceFile, member),
      });
      if (member.type) {
        classLevelAnnotations.push(buildAnnotation(sourceFile, member.type));
      }
    } else if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
      methods.push(readMethodLike(sourceFile, member));
    }
  }

  return {
    name,
    bases,
    fields,
    methods,
    annotations: classLevelAnnotations,
    line: line + 1,
    column: character + 1,
  };
}

function readFunctionDeclaration(sourceFile: ts.SourceFile, node: ts.FunctionDeclaration): TsFunction {
  const name = node.name?.text ?? "<anonymous>";
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const parameters = node.parameters.map((p) => p.name.getText(sourceFile));
  const decorators = readDecorators(sourceFile, node);
  const calls: TsCall[] = [];
  const annotations: TsAnnotation[] = [];
  if (node.body) {
    collectCallsAndAnnotations(node.body, sourceFile, calls, annotations);
  }
  for (const p of node.parameters) {
    if (p.type) annotations.push(buildAnnotation(sourceFile, p.type));
  }
  if (node.type) annotations.push(buildAnnotation(sourceFile, node.type));
  return {
    name,
    qualname: name,
    line: line + 1,
    column: character + 1,
    decorators,
    parameters,
    calls,
    annotations,
    fastapiRoute: false,
  };
}

function readArrowFunction(
  sourceFile: ts.SourceFile,
  name: string,
  node: ts.ArrowFunction | ts.FunctionExpression,
): TsFunction {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const parameters = node.parameters.map((p) => p.name.getText(sourceFile));
  const calls: TsCall[] = [];
  const annotations: TsAnnotation[] = [];
  collectCallsAndAnnotations(node.body, sourceFile, calls, annotations);
  for (const p of node.parameters) {
    if (p.type) annotations.push(buildAnnotation(sourceFile, p.type));
  }
  if (node.type) annotations.push(buildAnnotation(sourceFile, node.type));
  return {
    name,
    qualname: name,
    line: line + 1,
    column: character + 1,
    decorators: [],
    parameters,
    calls,
    annotations,
    fastapiRoute: false,
  };
}

function readMethodLike(
  sourceFile: ts.SourceFile,
  node: ts.MethodDeclaration | ts.ConstructorDeclaration,
): TsMethod {
  const name = ts.isConstructorDeclaration(node)
    ? "constructor"
    : node.name.getText(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const parameters = node.parameters.map((p) => p.name.getText(sourceFile));
  const decorators = readDecorators(sourceFile, node);
  const calls: TsCall[] = [];
  const annotations: TsAnnotation[] = [];
  if (node.body) {
    collectCallsAndAnnotations(node.body, sourceFile, calls, annotations);
  }
  for (const p of node.parameters) {
    if (p.type) annotations.push(buildAnnotation(sourceFile, p.type));
  }
  if (ts.isMethodDeclaration(node) && node.type) {
    annotations.push(buildAnnotation(sourceFile, node.type));
  }
  return {
    name,
    line: line + 1,
    column: character + 1,
    decorators,
    parameters,
    calls,
    annotations,
    fastapiRoute: false,
  };
}

function readDecorators(sourceFile: ts.SourceFile, node: ts.Node): string[] {
  // TS 5 keeps decorators in `node.modifiers` (with `isDecorator`).
  const out: string[] = [];
  const modifiers = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (modifiers) {
    for (const dec of modifiers) {
      out.push(dec.expression.getText(sourceFile));
    }
  }
  return out;
}

function collectCallsAndAnnotations(
  root: ts.Node,
  sourceFile: ts.SourceFile,
  calls: TsCall[],
  annotations: TsAnnotation[],
): void {
  ts.forEachChild(root, function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      calls.push({ name, line: line + 1, column: character + 1 });
    }
    if (ts.isTypeNode(node)) {
      annotations.push(buildAnnotation(sourceFile, node));
      // Don't descend into the type — its child nodes are not callable
      // and are already captured by the text representation.
      return;
    }
    ts.forEachChild(node, visit);
  });
}

function collectFileLevelCallsAndAnnotations(
  sourceFile: ts.SourceFile,
  calls: TsCall[],
  annotations: TsAnnotation[],
): void {
  for (const statement of sourceFile.statements) {
    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isImportDeclaration(statement)
    ) {
      // These are captured by the dedicated readers.
      continue;
    }
    collectCallsAndAnnotations(statement, sourceFile, calls, annotations);
  }
}

function buildAnnotation(sourceFile: ts.SourceFile, node: ts.TypeNode): TsAnnotation {
  const text = node.getText(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    text,
    names: extractTypeNames(text),
    line: line + 1,
    column: character + 1,
  };
}

function extractTypeNames(text: string): string[] {
  // Round 14 P1: extract the identifier tokens from a type expression.
  // Conservative tokenization — splits on anything that isn't part of
  // a JS/TS identifier — so `Promise<{ a: number }> | null` yields
  // `["Promise", "a", "number", "null"]`. Downstream `type-policy`
  // checks scan this list for `deny-type` matches.
  const matches = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
  return matches ? [...new Set(matches)] : [];
}

function lineColumnOf(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}
