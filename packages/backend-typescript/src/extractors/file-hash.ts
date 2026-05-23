import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

import * as ts from "typescript";
import { formatNodeId } from "@stele/call-graph-core";

import { buildNodeIdForDeclaration, getArity } from "./node-id-builder.js";
import type { ExtractorContext } from "./types.js";

/**
 * SHA-256 hash of a file's bytes, prefixed `sha256-` so the algorithm
 * is encoded in-band. Returned format matches the cache stored under
 * `contract/.cache/call-graph.json::fileHashes`.
 */
export function sha256File(absolutePath: string): string {
  const buf = readFileSync(absolutePath);
  return "sha256-" + createHash("sha256").update(buf).digest("hex");
}

/** SHA-256 of an arbitrary string (used by the methodResolutionHash builder). */
export function sha256String(input: string): string {
  return "sha256-" + createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Compute the project-wide methodResolutionHash. We walk every class
 * declaration in the project, look up its `implements` and `extends`
 * clauses, and record `(parentMethodNodeId, childMethodNodeId)` pairs
 * for any method that the parent declares without a body. The pairs
 * are sorted then SHA-256-hashed.
 *
 * When the hash changes between two extractions, any cached file
 * containing AmbiguousCalls must be re-resolved
 * (docs/design/phase-b/01-call-graph-extractor.md §6).
 */
export function computeMethodResolutionHash(ctx: ExtractorContext): string {
  const relations: string[] = [];

  for (const sourceFile of ctx.program.getSourceFiles()) {
    if (!shouldVisit(sourceFile, ctx)) continue;

    sourceFile.forEachChild(function visit(node: ts.Node): void {
      if (ts.isClassDeclaration(node)) {
        collectClassImplementations(node, ctx, relations);
      }
      node.forEachChild(visit);
    });
  }

  relations.sort();
  return sha256String(relations.join("\n"));
}

function shouldVisit(sourceFile: ts.SourceFile, ctx: ExtractorContext): boolean {
  if (sourceFile.isDeclarationFile) return false;
  if (sourceFile.fileName.includes("/node_modules/")) return false;
  if (!sourceFile.fileName.startsWith(ctx.projectRoot)) return false;
  return true;
}

function collectClassImplementations(
  cls: ts.ClassDeclaration,
  ctx: ExtractorContext,
  relations: string[],
): void {
  if (cls.heritageClauses === undefined) return;
  if (cls.name === undefined) return;

  for (const heritage of cls.heritageClauses) {
    if (
      heritage.token !== ts.SyntaxKind.ImplementsKeyword &&
      heritage.token !== ts.SyntaxKind.ExtendsKeyword
    ) {
      continue;
    }

    for (const expr of heritage.types) {
      const symbol = ctx.checker.getSymbolAtLocation(expr.expression);
      if (symbol === undefined) continue;
      const decls = symbol.declarations ?? [];
      for (const decl of decls) {
        if (ts.isInterfaceDeclaration(decl) || ts.isClassDeclaration(decl)) {
          recordMethodMatches(decl, cls, ctx, relations);
        }
      }
    }
  }
}

function recordMethodMatches(
  parent: ts.InterfaceDeclaration | ts.ClassDeclaration,
  child: ts.ClassDeclaration,
  ctx: ExtractorContext,
  relations: string[],
): void {
  for (const parentMember of parent.members) {
    const parentIsSig = ts.isMethodSignature(parentMember);
    const parentIsAbstractMethod =
      ts.isMethodDeclaration(parentMember) && parentMember.body === undefined;
    if (!parentIsSig && !parentIsAbstractMethod) continue;
    if (parentMember.name === undefined) continue;

    const methodName = parentMember.name.getText();

    for (const childMember of child.members) {
      if (!ts.isMethodDeclaration(childMember)) continue;
      if (childMember.name === undefined) continue;
      if (childMember.name.getText() !== methodName) continue;
      if (childMember.body === undefined) continue;

      try {
        const parentId = parentIsAbstractMethod
          ? buildNodeIdForDeclaration(parentMember as ts.MethodDeclaration, ctx)
          : buildSignatureNodeId(parentMember as ts.MethodSignature, parent, ctx);
        const childId = buildNodeIdForDeclaration(childMember, ctx);
        relations.push(`${parentId}\t${childId}`);
      } catch {
        // Skip malformed declarations rather than crash extraction.
      }
    }
  }
}

function buildSignatureNodeId(
  sig: ts.MethodSignature,
  parent: ts.InterfaceDeclaration | ts.ClassDeclaration,
  ctx: ExtractorContext,
): string {
  const sourceFile = sig.getSourceFile();
  const rel = relative(ctx.projectRoot, sourceFile.fileName).split(sep).join("/");
  const containerName = parent.name?.getText() ?? "<anonymous>";
  if (sig.name === undefined) {
    return formatNodeId({
      filePath: rel,
      container: [containerName],
      symbolName: "<unknown>",
      arity: 0,
    });
  }
  // Reuse method arity rules from node-id-builder. Method signatures
  // expose the same `parameters` array shape, so getArity works.
  const arity = getArity(sig as unknown as ts.FunctionLikeDeclaration);
  return formatNodeId({
    filePath: rel,
    container: [containerName],
    symbolName: sig.name.getText(),
    arity,
  });
}
