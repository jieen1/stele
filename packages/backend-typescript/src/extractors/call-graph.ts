import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { stableStringCompare } from "@stele/core";
import * as ts from "typescript";
import type {
  AmbiguousCall,
  CallGraph,
  CallGraphEdge,
  CallGraphExtractor,
  CallGraphNode,
  ExtractOptions,
  SourceSpan,
  UnresolvedCall,
} from "@stele/call-graph-core";

import { computeMethodResolutionHash, sha256File } from "./file-hash.js";
import { buildNodeIdForDeclaration } from "./node-id-builder.js";
import { resolveCallee } from "./resolve-callee.js";
import type { ExtractorContext } from "./types.js";

/**
 * TypeScript implementation of the cross-language `CallGraphExtractor`
 * contract from `@stele/call-graph-core`. See
 * docs/design/phase-b/01-call-graph-extractor.md §5 for the design.
 *
 * Resolution strategy summary:
 *
 * 1. For each `ts.CallExpression` / `ts.NewExpression`, ask the
 *    `TypeChecker` for the symbol at the call target. Single in-project
 *    declaration → resolved edge. Multiple → ambiguous. None → unresolved
 *    with a reason bucket.
 * 2. Calls into `node_modules` produce `extern:<logical>::*` NodeIds,
 *    with the logical name derived from the originating import
 *    specifier (and optionally remapped through `externAliasRegistry`).
 * 3. Dynamic dispatch (`Reflect.apply`, `obj[name]()`, callback
 *    indirection inside `.map`) is captured as `UnresolvedCall` with
 *    `reason: "dynamic"` per spec §IX MVP scope.
 */
export const tsCallGraphExtractor: CallGraphExtractor = {
  language: "typescript",

  async extract(options: ExtractOptions): Promise<CallGraph> {
    return runExtract(options, null);
  },

  async extractIncremental(
    options: ExtractOptions & { changedFiles: readonly string[]; previous: CallGraph },
  ): Promise<CallGraph> {
    return runExtract(options, {
      changedFiles: options.changedFiles,
      previous: options.previous,
    });
  },
};

interface IncrementalInput {
  readonly changedFiles: readonly string[];
  readonly previous: CallGraph;
}

async function runExtract(options: ExtractOptions, incremental: IncrementalInput | null): Promise<CallGraph> {
  const projectRoot = resolveProjectRoot(options.projectRoot);
  const program = createProgram(projectRoot, options.tsconfigPath);
  const checker = program.getTypeChecker();

  const sourceFilesFilter = new Set<string>((options.sourceFiles ?? []).map((p) => toPosix(p)));
  const ctx: ExtractorContext = {
    program,
    checker,
    projectRoot,
    sourceFiles: sourceFilesFilter,
  };

  // Compute new methodResolutionHash up front — needed both for cache
  // decisions and for the returned CallGraph.
  const methodResolutionHash = computeMethodResolutionHash(ctx);

  // Decide which files to extract this round. When non-incremental, we
  // extract everything that matches the source-file filter. When
  // incremental, we keep cached nodes/edges for files whose SHA-256 is
  // unchanged and re-parse only the changed set (plus, if the
  // methodResolutionHash changed, files containing ambiguous calls in
  // the previous run).
  const filesToVisit: ts.SourceFile[] = [];
  const fileHashes: Record<string, string> = {};
  const keptNodes: CallGraphNode[] = [];
  const keptEdges: CallGraphEdge[] = [];
  const keptUnresolved: UnresolvedCall[] = [];
  const keptAmbiguous: AmbiguousCall[] = [];

  const previousHashes: Record<string, string> =
    incremental !== null ? { ...incremental.previous.fileHashes } : {};
  const changedSet = new Set<string>(
    incremental !== null ? incremental.changedFiles.map((p) => toPosix(p)) : [],
  );
  const methodResolutionChanged =
    incremental !== null && incremental.previous.methodResolutionHash !== methodResolutionHash;

  // Files that had ambiguous calls in the previous run — must be
  // re-resolved when the method-resolution hash changes.
  const previousAmbiguousFiles = new Set<string>();
  if (incremental !== null) {
    for (const a of incremental.previous.ambiguousCalls) {
      const rel = ownerFileOfNodeId(a.fromId);
      if (rel !== null) previousAmbiguousFiles.add(rel);
    }
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!shouldVisit(sourceFile, ctx)) continue;

    const rel = toRelativePosix(sourceFile.fileName, projectRoot);

    // Apply the source-file filter, if any.
    if (sourceFilesFilter.size > 0 && !sourceFilesFilter.has(rel)) continue;

    const hash = sha256File(sourceFile.fileName);
    fileHashes[rel] = hash;

    if (incremental !== null) {
      const prevHash = previousHashes[rel];
      const needsReparse =
        prevHash === undefined ||
        prevHash !== hash ||
        changedSet.has(rel) ||
        (methodResolutionChanged && previousAmbiguousFiles.has(rel));

      if (!needsReparse) {
        // Keep previous data for this file.
        for (const n of incremental.previous.nodes) {
          if (n.filePath === rel) keptNodes.push(n);
        }
        for (const e of incremental.previous.edges) {
          // An edge belongs to a file based on its caller's NodeId.
          if (ownerFileOfNodeId(e.fromId) === rel) keptEdges.push(e);
        }
        for (const u of incremental.previous.unresolvedCalls) {
          if (ownerFileOfNodeId(u.fromId) === rel) keptUnresolved.push(u);
        }
        for (const a of incremental.previous.ambiguousCalls) {
          if (ownerFileOfNodeId(a.fromId) === rel) keptAmbiguous.push(a);
        }
        continue;
      }
    }

    filesToVisit.push(sourceFile);
  }

  // Walk the files we need to (re-)extract and produce nodes/edges.
  const nodes: CallGraphNode[] = [...keptNodes];
  const edges: CallGraphEdge[] = [...keptEdges];
  const unresolvedCalls: UnresolvedCall[] = [...keptUnresolved];
  const ambiguousCalls: AmbiguousCall[] = [...keptAmbiguous];

  for (const sourceFile of filesToVisit) {
    extractFromSourceFile(sourceFile, ctx, nodes, edges, unresolvedCalls, ambiguousCalls);
  }

  // Stable ordering — guarantee byte-stable output for caching.
  nodes.sort((a, b) => stableStringCompare(a.id, b.id));
  edges.sort(
    (a, b) =>
      stableStringCompare(a.fromId, b.fromId) ||
      stableStringCompare(a.toId, b.toId) ||
      a.callSite.line - b.callSite.line ||
      a.callSite.column - b.callSite.column,
  );
  unresolvedCalls.sort(
    (a, b) =>
      stableStringCompare(a.fromId, b.fromId) ||
      a.callSite.line - b.callSite.line ||
      a.callSite.column - b.callSite.column,
  );
  ambiguousCalls.sort(
    (a, b) =>
      stableStringCompare(a.fromId, b.fromId) ||
      a.callSite.line - b.callSite.line ||
      a.callSite.column - b.callSite.column,
  );

  return {
    schemaVersion: "1",
    language: "typescript",
    generatedAt: new Date().toISOString(),
    projectRoot,
    nodes,
    edges,
    unresolvedCalls,
    ambiguousCalls,
    methodResolutionHash,
    fileHashes,
  };
}

function shouldVisit(sourceFile: ts.SourceFile, ctx: ExtractorContext): boolean {
  if (sourceFile.isDeclarationFile) return false;
  if (sourceFile.fileName.includes("/node_modules/")) return false;
  if (!sourceFile.fileName.startsWith(ctx.projectRoot)) return false;
  return true;
}

function resolveProjectRoot(input: string): string {
  if (!isAbsolute(input)) {
    return resolve(input);
  }
  return input;
}

function createProgram(projectRoot: string, tsconfigPath: string | undefined): ts.Program {
  const configPath = tsconfigPath ?? resolve(projectRoot, "tsconfig.json");

  let rootNames: string[] = [];
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
  };

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = ts.parseConfigFileTextToJson(configPath, raw);
    if (parsed.error === undefined && parsed.config !== undefined) {
      const conf = ts.parseJsonConfigFileContent(parsed.config, ts.sys, projectRoot, compilerOptions, configPath);
      rootNames = conf.fileNames;
      compilerOptions = { ...conf.options, noEmit: true };
    }
  }

  if (rootNames.length === 0) {
    // Fallback: enumerate every .ts/.tsx/.js/.cjs/.mjs under projectRoot,
    // excluding node_modules and dist.
    rootNames = collectJsTsFiles(projectRoot);
  }

  // Closeout 2 (2026-05-25): `dist/` is build output, never source. The
  // fallback walker already excludes it; once `allowJs:true` is on, the
  // tsconfig-driven enumeration would otherwise pull in every emitted
  // chunk under packages/*/dist/*.js — duplicating call-graph nodes (the
  // .ts source already produced them) and ballooning extraction time
  // ~6x. Equalize the two paths so both reject build artifacts.
  rootNames = rootNames.filter((name) => !isInDistDir(name));

  return ts.createProgram({ rootNames, options: compilerOptions });
}

function isInDistDir(filePath: string): boolean {
  const posix = filePath.split(sep).join("/");
  return posix.includes("/dist/") || posix.endsWith("/dist") || posix.startsWith("dist/");
}

function collectJsTsFiles(root: string): string[] {
  const fs = readDirSync(root);
  return fs;
}

function readDirSync(root: string): string[] {
  // Tiny recursive directory walk — avoids pulling glob deps.
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === "dist" || ent.name === ".git") continue;
      const full = `${dir}${sep}${ent.name}`;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        if (isExtractableSourceFile(ent.name)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

function isExtractableSourceFile(name: string): boolean {
  // Ambient declaration files never have runtime behaviour — exclude.
  if (name.endsWith(".d.ts") || name.endsWith(".d.mts") || name.endsWith(".d.cts")) {
    return false;
  }
  return (
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".js") ||
    name.endsWith(".cjs") ||
    name.endsWith(".mjs")
  );
}

function extractFromSourceFile(
  sourceFile: ts.SourceFile,
  ctx: ExtractorContext,
  nodes: CallGraphNode[],
  edges: CallGraphEdge[],
  unresolvedCalls: UnresolvedCall[],
  ambiguousCalls: AmbiguousCall[],
): void {
  // Pass 1: collect function-like declarations as nodes.
  const declStack: ts.FunctionLikeDeclaration[] = [];
  const branchStack: BranchFlags[] = [];

  const enter = (node: ts.Node): void => {
    if (isFunctionLikeDeclaration(node)) {
      const decl = node as ts.FunctionLikeDeclaration;
      // Skip overload signatures with no body — the implementation is
      // a separate declaration that we'll visit instead, and both
      // produce the same NodeId, so emitting both would create
      // duplicate nodes.
      if (isOverloadSignatureWithoutBody(decl)) {
        node.forEachChild(enter);
        return;
      }
      try {
        const cgNode = buildCallGraphNode(decl, ctx);
        nodes.push(cgNode);
      } catch {
        // Skip nodes we can't NodeId (e.g. truly anonymous w/ no name).
      }
      declStack.push(decl);
      branchStack.push({ isConditional: false, isLoop: false, isAsync: false });
    } else {
      const flags = computeBranchFlagDelta(node);
      const prev = branchStack[branchStack.length - 1];
      if (prev !== undefined) {
        branchStack.push({
          isConditional: prev.isConditional || flags.isConditional,
          isLoop: prev.isLoop || flags.isLoop,
          isAsync: prev.isAsync || flags.isAsync,
        });
      } else {
        branchStack.push(flags);
      }
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const top = declStack[declStack.length - 1];
      if (top !== undefined) {
        recordCall(node, top, ctx, edges, unresolvedCalls, ambiguousCalls, branchStack);
      }
    }

    node.forEachChild(enter);

    // Pop on the way out.
    if (isFunctionLikeDeclaration(node)) {
      declStack.pop();
    }
    branchStack.pop();
  };

  enter(sourceFile);
}

interface BranchFlags {
  readonly isConditional: boolean;
  readonly isLoop: boolean;
  readonly isAsync: boolean;
}

function computeBranchFlagDelta(node: ts.Node): BranchFlags {
  if (
    ts.isIfStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isTryStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node)
  ) {
    return { isConditional: true, isLoop: false, isAsync: false };
  }
  if (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return { isConditional: false, isLoop: true, isAsync: false };
  }
  if (ts.isAwaitExpression(node)) {
    return { isConditional: false, isLoop: false, isAsync: true };
  }
  return { isConditional: false, isLoop: false, isAsync: false };
}

function recordCall(
  call: ts.CallExpression | ts.NewExpression,
  caller: ts.FunctionLikeDeclaration,
  ctx: ExtractorContext,
  edges: CallGraphEdge[],
  unresolvedCalls: UnresolvedCall[],
  ambiguousCalls: AmbiguousCall[],
  branchStack: readonly BranchFlags[],
): void {
  let callerId: string;
  try {
    callerId = buildNodeIdForDeclaration(caller, ctx);
  } catch {
    return;
  }

  const callSite = spanFromNode(call);
  const flags = branchStack[branchStack.length - 1] ?? {
    isConditional: false,
    isLoop: false,
    isAsync: false,
  };

  // Detect `.then(callback)` / `Promise.all([...])` as async edges
  // even when no `await` is visible — the awaited continuation is
  // logically async.
  const explicitAsync = isAsyncCallShape(call);

  const result = resolveCallee(call, ctx);
  if (result.kind === "resolved") {
    for (const toId of result.nodeIds) {
      edges.push({
        fromId: callerId,
        toId,
        callSite,
        isConditional: flags.isConditional,
        isLoop: flags.isLoop,
        isAsync: flags.isAsync || explicitAsync,
      });
    }
    return;
  }
  if (result.kind === "ambiguous") {
    ambiguousCalls.push({
      fromId: callerId,
      callSite,
      candidates: result.nodeIds,
    });
    return;
  }
  unresolvedCalls.push({
    fromId: callerId,
    callSite,
    rawText: result.rawText ?? call.getText(),
    reason: result.reason ?? "dynamic",
  });
}

function isAsyncCallShape(call: ts.CallExpression | ts.NewExpression): boolean {
  if (ts.isPropertyAccessExpression(call.expression)) {
    const name = call.expression.name.escapedText;
    if (name === "then" || name === "catch" || name === "finally") return true;
    // Promise.all / Promise.race / Promise.allSettled / Promise.any.
    if (
      ts.isIdentifier(call.expression.expression) &&
      call.expression.expression.escapedText === "Promise" &&
      (name === "all" || name === "race" || name === "allSettled" || name === "any")
    ) {
      return true;
    }
  }
  return false;
}

function buildCallGraphNode(decl: ts.FunctionLikeDeclaration, ctx: ExtractorContext): CallGraphNode {
  const sourceFile = decl.getSourceFile();
  const rel = toRelativePosix(sourceFile.fileName, ctx.projectRoot);
  const id = buildNodeIdForDeclaration(decl, ctx);
  const span = spanFromNode(decl);
  const kind = nodeKind(decl);
  const signature = buildSignature(decl);
  const isExported = checkExported(decl);
  const isAsync = isAsyncFunction(decl);

  return {
    id,
    kind,
    filePath: rel,
    span,
    signature,
    isExported,
    isAsync,
  };
}

function spanFromNode(node: ts.Node): SourceSpan {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function nodeKind(decl: ts.FunctionLikeDeclaration): CallGraphNode["kind"] {
  if (ts.isConstructorDeclaration(decl)) return "constructor";
  if (ts.isMethodDeclaration(decl) || ts.isGetAccessor(decl) || ts.isSetAccessor(decl)) return "method";
  if (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) return "lambda";
  return "function";
}

function buildSignature(decl: ts.FunctionLikeDeclaration): string {
  // Best-effort textual signature. We avoid getText() on huge bodies
  // by reading only the parameter list + return type annotation when
  // available.
  const params = (decl.parameters ?? [])
    .map((p) => p.getText())
    .join(", ");
  const ret = decl.type !== undefined ? `: ${decl.type.getText()}` : "";
  const name = (() => {
    if (ts.isConstructorDeclaration(decl)) return "constructor";
    if ((decl as { name?: ts.Node }).name !== undefined) {
      return ((decl as { name?: ts.Node }).name as ts.Node).getText();
    }
    return "anonymous";
  })();
  return `${name}(${params})${ret}`;
}

function checkExported(decl: ts.FunctionLikeDeclaration): boolean {
  // Modifiers were renamed in TS 5.x. Use the helper.
  const modifiers = ts.canHaveModifiers(decl as ts.Node) ? ts.getModifiers(decl as ts.HasModifiers) : undefined;
  if (modifiers !== undefined) {
    for (const m of modifiers) {
      if (m.kind === ts.SyntaxKind.ExportKeyword) return true;
    }
  }
  // Also check default-export shape: `export default function ...`.
  const parent = decl.parent;
  if (parent !== undefined && ts.isExportAssignment(parent)) return true;
  return false;
}

function isAsyncFunction(decl: ts.FunctionLikeDeclaration): boolean {
  const modifiers = ts.canHaveModifiers(decl as ts.Node) ? ts.getModifiers(decl as ts.HasModifiers) : undefined;
  if (modifiers !== undefined) {
    for (const m of modifiers) {
      if (m.kind === ts.SyntaxKind.AsyncKeyword) return true;
    }
  }
  return false;
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

function isOverloadSignatureWithoutBody(decl: ts.FunctionLikeDeclaration): boolean {
  if (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) return false;
  // FunctionDeclaration / MethodDeclaration / ConstructorDeclaration /
  // GetAccessor / SetAccessor all expose a `.body?: Block`.
  const body = (decl as { body?: ts.Node }).body;
  return body === undefined;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function toRelativePosix(absolute: string, projectRoot: string): string {
  return relative(projectRoot, absolute).split(sep).join("/");
}

function ownerFileOfNodeId(id: string): string | null {
  // NodeId format: `{filePath}::...` or `extern:...`. We just need the
  // file path for in-project entries.
  if (id.startsWith("extern:")) return null;
  const idx = id.indexOf("::");
  if (idx <= 0) return null;
  return id.slice(0, idx);
}
