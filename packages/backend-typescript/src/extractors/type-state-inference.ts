/**
 * TypeScript phantom-type-based implementation of the cross-language
 * `TypeStateInferenceExtractor` trait from `@stele/type-state-evaluator`.
 *
 * The trait answers one question for the evaluator:
 *
 *   "At call site (caller, line, col), what state was the receiver
 *    variable in?"
 *
 * In TypeScript the state lives in a phantom type parameter on the
 * target type (B.1 convention):
 *
 *     type Order<S extends OrderState = "Draft"> = { __state: S; ... };
 *     function createOrder(): Order<"Draft">;
 *     function submit(o: Order<"Draft">): Order<"Submitted">;
 *
 * For every CallExpression of the shape `receiver.method(...)` where
 * `receiver`'s type instantiates one of `decl.target`'s methods, we
 * read the FIRST type argument of the receiver and, if it is a string
 * literal, report it as the inferred state. Anything else (unbound
 * generic, missing annotation, async/promise erasure) yields
 * `inferredState: undefined` with a brief diagnostic.
 *
 * Cross-function propagation is intentionally NOT supported in B.1 — a
 * function that takes `Order` without a phantom state annotation will
 * have its calls report inference failure. Authors opt back in via
 * `(type-state-binding ...)`; the evaluator suppresses inference
 * failures for callers covered by a binding.
 *
 * See docs/design/phase-b/03-type-state.md §四 + §五.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { stableStringCompare } from "@stele/core";
import * as ts from "typescript";
import type {
  InferTypeStatesOptions,
  InferTypeStatesResult,
  InferredStateAtCallSite,
  TypeStateInferenceExtractor,
} from "@stele/type-state-evaluator";
import type {
  TypeStateBindingDeclaration,
  TypeStateDeclaration,
} from "@stele/core";

import { buildNodeIdForDeclaration } from "./node-id-builder.js";
import type { ExtractorContext } from "./types.js";

/** Internal: parsed `path::TypeName` target. */
interface ParsedTarget {
  readonly filePath: string;
  readonly typeName: string;
  readonly hasGlob: boolean;
}

function parseTarget(target: string): ParsedTarget | null {
  const sepIdx = target.lastIndexOf("::");
  if (sepIdx <= 0) return null;
  const filePath = target.slice(0, sepIdx);
  const typeName = target.slice(sepIdx + 2);
  const hasGlob = filePath.includes("*") || typeName.includes("*");
  return { filePath, typeName, hasGlob };
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function toRelativePosix(absolute: string, projectRoot: string): string {
  return relative(projectRoot, absolute).split(sep).join("/");
}

/** Build a ts.Program rooted at projectRoot's tsconfig.json. */
function createProgram(projectRoot: string, tsconfigPath: string | undefined): ts.Program | null {
  const configPath = tsconfigPath ?? resolve(projectRoot, "tsconfig.json");

  let rootNames: string[] = [];
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    esModuleInterop: true,
  };

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = ts.parseConfigFileTextToJson(configPath, raw);
    if (parsed.error === undefined && parsed.config !== undefined) {
      const conf = ts.parseJsonConfigFileContent(
        parsed.config,
        ts.sys,
        projectRoot,
        compilerOptions,
        configPath,
      );
      rootNames = conf.fileNames;
      compilerOptions = { ...conf.options, noEmit: true };
    }
  }

  if (rootNames.length === 0) {
    rootNames = collectTsFiles(projectRoot);
  }

  if (rootNames.length === 0) return null;
  return ts.createProgram({ rootNames, options: compilerOptions });
}

function collectTsFiles(root: string): string[] {
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
        if ((ent.name.endsWith(".ts") || ent.name.endsWith(".tsx")) && !ent.name.endsWith(".d.ts")) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

function spanOf(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: start.line + 1, column: start.character + 1 };
}

/**
 * Read the first concrete type argument of a TypeReference. Returns the
 * literal string value of the FIRST type argument when it is a string
 * literal type, otherwise null (caller treats null as inference failure).
 */
function readPhantomState(type: ts.Type, checker: ts.TypeChecker): {
  state: string | null;
  reason: string;
} {
  // Promise<T> erasure: unwrap once when the type is awaited (covers
  // `await someAsyncFn()` patterns).
  const awaited = unwrapPromise(type, checker);
  const effective = awaited ?? type;

  const args = getTypeArguments(effective, checker);
  if (args.length === 0) {
    return { state: null, reason: "receiver type has no type arguments (missing phantom state annotation)" };
  }
  const first = args[0];
  if (first === undefined) {
    return { state: null, reason: "receiver type's first type argument is undefined" };
  }
  if (first.isStringLiteral()) {
    return { state: first.value, reason: `phantom type argument resolved to "${first.value}"` };
  }
  // Union of literals: e.g. `"Draft" | "Submitted"`. We treat this as
  // inference failure because the call site could be in either state.
  if (first.isUnion()) {
    const allLiterals = first.types.every((t) => t.isStringLiteral());
    if (allLiterals) {
      const values = first.types
        .map((t) => (t.isStringLiteral() ? `"${t.value}"` : "?"))
        .join(" | ");
      return {
        state: null,
        reason: `receiver phantom state is a union of literals (${values}); cannot pick a single state`,
      };
    }
  }
  // Unbound generic (TypeParameter) — `Order<S>` inside generic fn.
  if (first.flags & ts.TypeFlags.TypeParameter) {
    const sym = first.symbol;
    const name = sym?.getName() ?? "<anonymous>";
    return { state: null, reason: `receiver type has unbound generic parameter ${name}` };
  }
  return {
    state: null,
    reason: "receiver phantom state is not a string literal type",
  };
}

function unwrapPromise(type: ts.Type, checker: ts.TypeChecker): ts.Type | null {
  const sym = type.getSymbol();
  if (sym === undefined) return null;
  if (sym.getName() !== "Promise") return null;
  const args = getTypeArguments(type, checker);
  if (args.length === 0) return null;
  return args[0] ?? null;
}

function getTypeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  // Prefer the public API (`getTypeArguments`) over reading the
  // internal `typeArguments` property — the public API handles type
  // reference indirection consistently across TS versions.
  const ref = type as ts.TypeReference;
  // checker.getTypeArguments only exists on type references.
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  const objectFlags = (ref as unknown as { objectFlags?: number }).objectFlags ?? 0;
  if ((objectFlags & ts.ObjectFlags.Reference) === 0) {
    // Some inferred shapes are objects but not refs; the type arguments
    // are stored on the `aliasTypeArguments` slot via type aliases.
    const alias = (type.aliasTypeArguments ?? []) as readonly ts.Type[];
    return alias;
  }
  try {
    return checker.getTypeArguments(ref);
  } catch {
    return [];
  }
}

/**
 * Find the symbol declaration of `typeName` in `sourceFile`. Returns
 * the Symbol when present, else null.
 */
function findTypeDeclarationSymbol(
  sourceFile: ts.SourceFile,
  typeName: string,
  checker: ts.TypeChecker,
): ts.Symbol | null {
  // Look at top-level declarations only — the agent puts the target
  // type at module scope per convention.
  for (const stmt of sourceFile.statements) {
    if (
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isClassDeclaration(stmt)
    ) {
      const name = stmt.name;
      if (name !== undefined && name.text === typeName) {
        const sym = checker.getSymbolAtLocation(name);
        if (sym !== undefined) return sym;
      }
    }
  }
  return null;
}

/**
 * Determine whether `receiverType` is (an instantiation of) the target
 * type. We compare the receiver's symbol to the symbol of the target
 * type declaration — symbol identity is the most robust signal.
 */
function receiverMatchesTarget(
  receiverType: ts.Type,
  targetSymbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  const sym = receiverType.getSymbol();
  if (sym === targetSymbol) return true;
  // Try the aliased symbol — type aliases are common (e.g. `type Order<S> = ...`).
  const aliasSym = receiverType.aliasSymbol;
  if (aliasSym === targetSymbol) return true;
  // Awaited form: receiver was `Promise<Order<S>>`.
  const unwrapped = unwrapPromise(receiverType, checker);
  if (unwrapped !== null) {
    const usym = unwrapped.getSymbol();
    if (usym === targetSymbol) return true;
    if (unwrapped.aliasSymbol === targetSymbol) return true;
  }
  return false;
}

/**
 * Given a function-like declaration that is the lexical caller of a
 * call site, return the binding that targets it (if any). We match on
 * full NodeId and also tolerate the agent-friendly form without a
 * disambiguator suffix.
 */
function findBindingForCaller(
  callerId: string,
  bindings: readonly TypeStateBindingDeclaration[],
): TypeStateBindingDeclaration | null {
  const stripped = callerId.replace(/#[0-9a-f]{8}$/, "");
  for (const b of bindings) {
    if (b.function === callerId) return b;
    if (b.function.replace(/#[0-9a-f]{8}$/, "") === stripped) return b;
  }
  return null;
}

/**
 * Resolve receiver state by walking up the enclosing function chain.
 *
 * The receiver of `o.method()` is the expression `o`. We try:
 *
 *   1. The TypeChecker's resolved type of the receiver — covers
 *      construction (`createOrder()`), transition return types
 *      (`submit(o)` returning Order<"Submitted">), and parameter
 *      annotations (`function pay(o: Order<"Submitted">)`).
 *   2. If the type checker's view yields no concrete state AND the
 *      enclosing function has a matching `(type-state-binding ...)`,
 *      and the receiver resolves to a parameter index of that
 *      function, use the binding's state for that parameter.
 *
 * Steps 1+2 cover the B.1 contract. We do NOT chase the receiver
 * through cross-function dataflow.
 */
function inferReceiverStateAt(
  receiver: ts.Expression,
  caller: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  binding: TypeStateBindingDeclaration | null,
  targetSymbol: ts.Symbol,
): { state: string | null; reason: string; flowSteps: string[] } {
  const receiverType = checker.getTypeAtLocation(receiver);

  // Make sure we're talking about the target type at all. If not, we
  // shouldn't be inferring — that's a guard against ambiguous
  // PropertyAccessExpressions where receiver isn't really the target.
  if (!receiverMatchesTarget(receiverType, targetSymbol, checker)) {
    return {
      state: null,
      reason: "receiver type does not match the type-state target",
      flowSteps: [],
    };
  }

  const phantom = readPhantomState(receiverType, checker);
  if (phantom.state !== null) {
    return {
      state: phantom.state,
      reason: phantom.reason,
      flowSteps: describeProvenance(receiver),
    };
  }

  // Phantom inference failed. Try the binding fallback if the receiver
  // is an Identifier that resolves to a parameter of `caller`.
  if (binding !== null && ts.isIdentifier(receiver)) {
    const paramIndex = findParameterIndex(receiver, caller, checker);
    if (paramIndex !== null) {
      const paramBinding = binding.params.find((p) => p.index === paramIndex);
      if (paramBinding !== undefined) {
        return {
          state: paramBinding.state,
          reason: `(type-state-binding ...) sets param ${paramIndex} state to ${paramBinding.state}`,
          flowSteps: [`binding: param ${paramIndex} → ${paramBinding.state}`],
        };
      }
    }
  }

  return { state: null, reason: phantom.reason, flowSteps: [] };
}

function describeProvenance(receiver: ts.Expression): string[] {
  if (ts.isCallExpression(receiver)) {
    // `submit(o)` style — receiver is the return value of a function.
    const expr = receiver.expression;
    if (ts.isIdentifier(expr)) {
      return [`returned from ${expr.text}()`];
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return [`returned from .${expr.name.text}()`];
    }
    return ["returned from call"];
  }
  if (ts.isIdentifier(receiver)) {
    return [`variable ${receiver.text}`];
  }
  if (ts.isAwaitExpression(receiver)) {
    return ["awaited promise"];
  }
  return [];
}

function findParameterIndex(
  ident: ts.Identifier,
  caller: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): number | null {
  const sym = checker.getSymbolAtLocation(ident);
  if (sym === undefined) return null;
  const decls = sym.getDeclarations() ?? [];
  for (const d of decls) {
    if (ts.isParameter(d) && d.parent === caller) {
      const params = caller.parameters ?? [];
      // Walk the parameter list, skipping the implicit `this` parameter
      // so the index matches the user-visible arity used by CDL bindings.
      let visibleIndex = 0;
      for (const p of params) {
        if (
          p.name.kind === ts.SyntaxKind.Identifier &&
          (p.name as ts.Identifier).escapedText === "this"
        ) {
          if (p === d) return null;
          continue;
        }
        if (p === d) return visibleIndex;
        visibleIndex++;
      }
    }
  }
  return null;
}

function findEnclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur !== undefined) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessor(cur) ||
      ts.isSetAccessor(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Walk every CallExpression in `sourceFile` and emit an
 * InferredStateAtCallSite per receiver-method call against the target
 * type. We do NOT filter by allowed-ops here — the evaluator does that.
 */
function inferInSourceFile(
  sourceFile: ts.SourceFile,
  ctx: ExtractorContext,
  decl: TypeStateDeclaration,
  targetSymbol: ts.Symbol,
  bindings: readonly TypeStateBindingDeclaration[],
  out: InferredStateAtCallSite[],
): void {
  const checker = ctx.checker;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      maybeRecord(node);
    }
    ts.forEachChild(node, visit);
  };

  const maybeRecord = (call: ts.CallExpression): void => {
    const expr = call.expression;
    if (!ts.isPropertyAccessExpression(expr)) return;

    const receiver = expr.expression;
    const method = expr.name.text;

    const receiverType = checker.getTypeAtLocation(receiver);
    if (!receiverMatchesTarget(receiverType, targetSymbol, checker)) return;

    const caller = findEnclosingFunction(call);
    if (caller === null) return;

    let callerId: string;
    try {
      callerId = buildNodeIdForDeclaration(caller, ctx);
    } catch {
      return;
    }

    const callPos = spanOf(sourceFile, call);

    // Try to find a receiver name. For `o.method()` this is `o`. For
    // chained constructions like `createOrder().pay()` we use a synthetic
    // tag so the evaluator gets a stable identifier.
    const receiverName = ts.isIdentifier(receiver) ? receiver.text : receiver.getText();

    const binding = findBindingForCaller(callerId, bindings);
    const inferred = inferReceiverStateAt(
      receiver,
      caller,
      checker,
      binding,
      targetSymbol,
    );

    const origin = (() => {
      // Origin = where the receiver expression itself lives. For
      // call-expression receivers this points to the inner call; for
      // identifiers it points to the identifier's use site. We don't
      // chase back to the original `const x = ...` decl in B.1 — the
      // identifier site is sufficient for the violation report.
      const pos = spanOf(sourceFile, receiver);
      return {
        path: toRelativePosix(sourceFile.fileName, ctx.projectRoot),
        line: pos.line,
        column: pos.column,
      };
    })();

    out.push({
      callerId,
      callSite: callPos,
      receiverName,
      method,
      declarationId: decl.id,
      inferredState: inferred.state ?? undefined,
      inferenceReason: inferred.reason,
      inferenceOrigin: origin,
      flowSteps: Object.freeze(inferred.flowSteps.slice()),
    });
  };

  visit(sourceFile);
}

function shouldVisit(sourceFile: ts.SourceFile, projectRoot: string): boolean {
  if (sourceFile.isDeclarationFile) return false;
  if (sourceFile.fileName.includes("/node_modules/")) return false;
  const fnPosix = toPosix(sourceFile.fileName);
  const rootPosix = toPosix(projectRoot);
  return fnPosix.startsWith(rootPosix);
}

export const tsTypeStateInferenceExtractor: TypeStateInferenceExtractor = {
  language: "typescript",

  async inferTypeStates(options: InferTypeStatesOptions): Promise<InferTypeStatesResult> {
    const projectRoot = isAbsolute(options.projectRoot)
      ? options.projectRoot
      : resolve(options.projectRoot);

    const program = createProgram(projectRoot, undefined);
    if (program === null) {
      return { inferences: Object.freeze([]) };
    }
    const checker = program.getTypeChecker();
    const ctx: ExtractorContext = {
      program,
      checker,
      projectRoot,
      sourceFiles: new Set<string>(),
    };

    const out: InferredStateAtCallSite[] = [];

    for (const decl of options.declarations) {
      const parsed = parseTarget(decl.target);
      if (parsed === null) continue;
      if (parsed.hasGlob) {
        // B.1 MC-3: targeted glob is a Go separate-types story; the TS
        // extractor cannot handle it. Skip silently.
        continue;
      }

      // Resolve target type symbol via the source file at parsed.filePath.
      const absTargetPath = resolve(projectRoot, parsed.filePath);
      const targetSourceFile = program.getSourceFile(absTargetPath);
      if (targetSourceFile === undefined) continue;

      const targetSymbol = findTypeDeclarationSymbol(targetSourceFile, parsed.typeName, checker);
      if (targetSymbol === null) continue;

      for (const sourceFile of program.getSourceFiles()) {
        if (!shouldVisit(sourceFile, projectRoot)) continue;
        inferInSourceFile(sourceFile, ctx, decl, targetSymbol, options.bindings, out);
      }
    }

    // Deterministic ordering — same shape as the call-graph extractor.
    out.sort((a, b) => {
      const c1 = stableStringCompare(a.declarationId, b.declarationId);
      if (c1 !== 0) return c1;
      const c2 = stableStringCompare(a.callerId, b.callerId);
      if (c2 !== 0) return c2;
      if (a.callSite.line !== b.callSite.line) return a.callSite.line - b.callSite.line;
      if (a.callSite.column !== b.callSite.column) return a.callSite.column - b.callSite.column;
      return stableStringCompare(a.method, b.method);
    });

    return { inferences: Object.freeze(out) };
  },
};

