import { relative, sep } from "node:path";

import * as ts from "typescript";
import { computeDisambiguator, formatNodeId } from "@stele/call-graph-core";

import type { ExtractorContext } from "./types.js";

/**
 * Build a NodeId for a function-like declaration.
 *
 * Rules implemented (per docs/design/phase-b/01-call-graph-extractor.md §3):
 *
 * - Implicit `this` is NOT counted in arity. We detect it via the
 *   special `this` parameter syntax (`function f(this: T, x: number)`)
 *   and exclude it.
 * - Method overloading: if the same `(file, container, name, arity)`
 *   appears ≥2 times in a source file, the disambiguator is computed
 *   from the comma-joined normalised parameter type texts. Otherwise
 *   the disambiguator is omitted.
 * - Lambdas / arrow functions / function expressions use
 *   `lambda@<line>:<col>` as the symbol name.
 * - Default-valued, rest, and destructuring parameters all count as
 *   one parameter each.
 */
export function buildNodeIdForDeclaration(
  decl: ts.FunctionLikeDeclaration,
  ctx: ExtractorContext,
): string {
  const sourceFile = decl.getSourceFile();
  const rel = relative(ctx.projectRoot, sourceFile.fileName).split(sep).join("/");
  const container = getContainerChain(decl);
  const symbolName = getSymbolName(decl);
  const arity = getArity(decl);
  const disambiguator = computeOverloadDisambiguator(decl, sourceFile, container, symbolName, arity);

  return formatNodeId({
    filePath: rel,
    container,
    symbolName,
    arity,
    disambiguator,
  });
}

/**
 * Walk up the AST from `decl` and collect class / interface names that
 * lexically enclose it. The chain is outermost-first.
 *
 * Example: nested class `Outer { class Inner { method() {} } }` yields
 * `["Outer", "Inner"]`.
 */
export function getContainerChain(decl: ts.Node): string[] {
  const chain: string[] = [];
  let current: ts.Node | undefined = decl.parent;
  while (current !== undefined) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      if (current.name !== undefined) {
        chain.unshift(current.name.getText());
      } else {
        chain.unshift("<anonymous-class>");
      }
    } else if (ts.isInterfaceDeclaration(current)) {
      chain.unshift(current.name.getText());
    }
    current = current.parent;
  }
  return chain;
}

/**
 * Arity: number of declared parameters, EXCLUDING an explicit `this`
 * parameter. Default values, rest, and object destructuring each count
 * as one parameter (the array length, not the number of bound names).
 */
export function getArity(decl: ts.FunctionLikeDeclaration): number {
  const params = decl.parameters ?? [];
  let n = 0;
  for (const p of params) {
    if (isImplicitThisParameter(p)) continue;
    n++;
  }
  return n;
}

function isImplicitThisParameter(param: ts.ParameterDeclaration): boolean {
  // TypeScript `this` parameters: `function f(this: T, ...)`. Detect
  // them via the Identifier node whose text is literally `this`. This
  // matches the TS compiler's own treatment of the parameter.
  if (param.name.kind !== ts.SyntaxKind.Identifier) return false;
  return (param.name as ts.Identifier).escapedText === "this";
}

function getSymbolName(decl: ts.FunctionLikeDeclaration): string {
  // Constructor declarations have no name node — represent as `<constructor>`.
  if (ts.isConstructorDeclaration(decl)) return "<constructor>";

  // FunctionDeclaration, MethodDeclaration, GetAccessor, SetAccessor all
  // expose `.name`. ArrowFunction and FunctionExpression usually do not.
  if (
    ts.isFunctionDeclaration(decl) ||
    ts.isMethodDeclaration(decl) ||
    ts.isGetAccessor(decl) ||
    ts.isSetAccessor(decl)
  ) {
    if (decl.name !== undefined) {
      return decl.name.getText();
    }
  }

  // Arrow function / function expression — see if it's bound to a
  // variable. `const foo = () => {}` gives us "foo".
  if (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) {
    const parent = decl.parent;
    if (parent !== undefined && ts.isVariableDeclaration(parent) && parent.name.kind === ts.SyntaxKind.Identifier) {
      return parent.name.getText();
    }
    if (parent !== undefined && ts.isPropertyAssignment(parent)) {
      return parent.name.getText();
    }
    if (parent !== undefined && ts.isPropertyDeclaration(parent) && parent.name !== undefined) {
      return parent.name.getText();
    }
  }

  // True anonymous — use lambda@line:col.
  const sourceFile = decl.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(decl.getStart());
  return `lambda@${line + 1}:${character + 1}`;
}

function computeOverloadDisambiguator(
  decl: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  container: readonly string[],
  symbolName: string,
  arity: number,
): string | undefined {
  // Only attempt for named function-likes; lambdas are unique by
  // line:col already.
  if (symbolName.startsWith("lambda@")) return undefined;

  // Count peer declarations with the same container + name + arity in
  // the same source file. We treat overload signatures (no body) of
  // the SAME function as one declaration (the implementation), not
  // separate ones.
  let collisions = 0;
  const visit = (node: ts.Node): void => {
    if (isFunctionLikeDeclaration(node)) {
      const candidate = node;
      // Skip overload signatures without bodies — they share the impl.
      if (!hasBody(candidate)) {
        ts.forEachChild(node, visit);
        return;
      }
      const peerContainer = getContainerChain(candidate);
      const peerName = getSymbolName(candidate);
      const peerArity = getArity(candidate);
      if (
        peerName === symbolName &&
        peerArity === arity &&
        sameContainerChain(peerContainer, container)
      ) {
        collisions++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (collisions <= 1) return undefined;

  const typeSig = (decl.parameters ?? [])
    .filter((p) => !isImplicitThisParameter(p))
    .map((p) => (p.type !== undefined ? p.type.getText() : "any"))
    .join(",");
  return computeDisambiguator(typeSig);
}

function hasBody(decl: ts.FunctionLikeDeclaration): boolean {
  // FunctionDeclaration, MethodDeclaration, ConstructorDeclaration all
  // expose `.body?: Block | undefined`. ArrowFunction body is always
  // present (block or expression).
  if (ts.isArrowFunction(decl)) return true;
  if (ts.isFunctionExpression(decl)) return true;
  // FunctionDeclaration | MethodDeclaration | ConstructorDeclaration |
  // GetAccessorDeclaration | SetAccessorDeclaration.
  const body = (decl as { body?: ts.Node }).body;
  return body !== undefined;
}

function sameContainerChain(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}
