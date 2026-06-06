import * as ts from "typescript";
import { formatNodeId } from "@stele/call-graph-core";

import { buildNodeIdForDeclaration } from "./node-id-builder.js";
import type { ExtractorContext, ResolvedCallee } from "./types.js";

/**
 * Resolve a `ts.CallExpression` (or `ts.NewExpression`) to one or more
 * callee NodeIds. The result distinguishes:
 *
 * - `resolved`: a single in-project callee (one NodeId in `nodeIds`).
 * - `ambiguous`: multiple in-project candidates (e.g. interface method
 *   with several class implementations).
 * - `unresolved`: dynamic (`obj[name]()`, `Reflect.apply(...)`),
 *   reflective, or extern-but-untracked. `reason` carries the bucket, and
 *   `nameHidden` distinguishes NAME-HIDDEN forms (computed-member, reflection,
 *   dynamic-import — the callee name is a runtime value, so the call COULD
 *   reach any target) from NAME-VISIBLE indirection (a named identifier /
 *   param / property whose symbol simply did not bind — the visible name
 *   cannot be a hidden bypass of a named trace target). The trace fail-closed
 *   gate fires only on `nameHidden`.
 *
 * External-library calls produce a `resolved` `extern:` NodeId — they
 * are out of project but we still know where they go logically. Only
 * truly unknown extern targets fall into `unresolved`.
 */
export function resolveCallee(
  call: ts.CallExpression | ts.NewExpression,
  ctx: ExtractorContext,
): ResolvedCallee {
  const expr = call.expression;
  const rawText = call.getText();

  // Dynamic dispatch first — `Reflect.apply`, `Reflect.construct`,
  // `Function.prototype.apply`, `obj[name]()`, etc. All of these HIDE the
  // called name (it is a runtime value), so they could reach any target.
  const dynamic = detectDynamicDispatch(expr);
  if (dynamic !== null) {
    return {
      kind: "unresolved",
      nodeIds: [],
      reason: dynamic,
      rawText,
      nameHidden: true,
    };
  }

  // `super(...)` — call the parent class's constructor. Walk up from
  // the call to find the enclosing class, then resolve to the parent
  // class's constructor declaration (in-project) or treat as a no-op
  // edge when the parent is a built-in (Error, Object, ...). Never
  // unresolved — `super` is structurally unambiguous.
  if (ts.isCallExpression(call) && expr.kind === ts.SyntaxKind.SuperKeyword) {
    return resolveSuperCall(call, ctx, rawText);
  }

  // Identify the symbol at the call site. `.expression.name` for
  // property access, the expression itself for bare identifiers.
  const target = getResolutionTarget(expr);
  if (target === null) {
    // No statically-recoverable callee name: dynamic `import(...)` whose
    // namespace member is invoked, a call-returns-a-function form `getFn()()`,
    // or an IIFE. In every case the invoked name is HIDDEN, so the call could
    // reach any target — fail-closed applies.
    return {
      kind: "unresolved",
      nodeIds: [],
      reason: "dynamic",
      rawText,
      nameHidden: true,
    };
  }

  const symbol = ctx.checker.getSymbolAtLocation(target);
  if (symbol === undefined) {
    // The callee NAME is statically visible (a named identifier / property /
    // param), we just could not bind its symbol. The visible name cannot BE a
    // named trace target unless it matches the target pattern — in which case
    // it would have resolved to an edge — so this is NOT a hidden bypass.
    return {
      kind: "unresolved",
      nodeIds: [],
      reason: "module-not-resolved",
      rawText,
      nameHidden: false,
    };
  }

  // Aliased symbols (e.g. import aliases) need to be followed.
  const resolved = followAlias(symbol, ctx.checker);
  let decls = resolved.declarations ?? [];
  // Single-identifier alias deref (one hop). `const w = writeFileSync; w()`
  // binds `w` to a VariableDeclaration whose initializer is a BARE identifier
  // referencing another known symbol. Without this hop `w` is a non-function
  // in-project variable → dropped → unresolved → the trace/effect ordering
  // analysis goes blind. Follow the initializer ONE hop so the alias resolves
  // to the same extern / in-project node a direct call would (it becomes a
  // real edge, caught directly rather than only via the fail-closed gate).
  //
  // Conservative: single hop, identifier-initializer ONLY. Arrow / function
  // expression initializers are already handled downstream by
  // `dereferenceVariableBindings`; we leave them untouched.
  const aliasTargetDecls = dereferenceIdentifierAlias(decls, ctx);
  if (aliasTargetDecls !== null) {
    decls = aliasTargetDecls;
  }
  if (decls.length === 0) {
    // Named callee, symbol bound but no declarations reachable — still a
    // visible name, not a hidden bypass.
    return {
      kind: "unresolved",
      nodeIds: [],
      reason: "module-not-resolved",
      rawText,
      nameHidden: false,
    };
  }

  const inProject: ts.Declaration[] = [];
  const externDecls: ts.Declaration[] = [];

  for (const decl of decls) {
    const sf = decl.getSourceFile();
    if (sf.isDeclarationFile) {
      externDecls.push(decl);
    } else if (sf.fileName.includes("/node_modules/")) {
      externDecls.push(decl);
    } else if (sf.fileName.startsWith(ctx.projectRoot)) {
      inProject.push(decl);
    } else {
      // Source file outside the project root — treat as extern-like.
      externDecls.push(decl);
    }
  }

  // Variable declarations whose initializer is an arrow/function
  // expression should resolve to the inner function, not the variable.
  const dereferenced = dereferenceVariableBindings(inProject);

  // If the in-project declarations are MethodSignature (interface
  // methods, abstract methods on classes with no body), expand to all
  // implementing-class method declarations in the program. Multiple
  // implementations → ambiguous; one → resolved.
  const expandedInProject = expandInterfaceMethods(dereferenced, ctx);

  if (expandedInProject.length > 0) {
    // For `new X(args)`, the symbol resolves to the CLASS, not its
    // constructor. Walk through any class declarations and replace
    // them with their constructor(s). When the class has no explicit
    // constructor we still record an edge to the synthetic `new X`
    // form using the class declaration as the target — the consumer
    // (trace evaluator) can decide what to do.
    const expanded: ts.Declaration[] = [];
    const isNewExpr = ts.isNewExpression(call);
    let hadImplicitInProjectCtor = false;
    for (const d of expandedInProject) {
      if (isNewExpr && ts.isClassDeclaration(d)) {
        const ctors = d.members.filter((m) => ts.isConstructorDeclaration(m));
        if (ctors.length > 0) {
          for (const c of ctors) expanded.push(c);
          continue;
        }
        // No explicit ctor — walk the extends chain. The implicit
        // ctor is a synthetic `super(...args)` so its only "effect"
        // is whatever the nearest in-project ancestor's ctor does. If
        // the chain terminates at a built-in (Error, Object, ...) the
        // edge is a no-op. Either way we have a structurally-known
        // answer and must NOT fall back to unresolved.
        const inherited = findInheritedConstructor(d, ctx);
        if (inherited !== null) {
          expanded.push(inherited);
        }
        hadImplicitInProjectCtor = true;
        continue;
      }
      expanded.push(d);
    }
    const nodeIds = expanded
      .filter((d) => isFunctionLikeForNode(d))
      .map((d) => buildNodeIdForDeclaration(d as ts.FunctionLikeDeclaration, ctx));

    // De-duplicate (different overload signatures of the same impl
    // collapse to the same NodeId; we keep one).
    const unique = uniqueSortedStrings(nodeIds);

    if (unique.length === 0) {
      // Same-file `new X()` of a class whose implicit ctor's chain
      // ends at a built-in: structurally resolved, just no in-project
      // edge to emit.
      if (hadImplicitInProjectCtor) {
        return { kind: "resolved", nodeIds: [], rawText };
      }
      // A named `new X()` whose ctor chain produced no in-project edge — the
      // class name is statically visible, so this is not a hidden bypass.
      return {
        kind: "unresolved",
        nodeIds: [],
        reason: "dynamic",
        rawText,
        nameHidden: false,
      };
    }
    if (unique.length === 1) {
      return { kind: "resolved", nodeIds: unique, rawText };
    }
    return { kind: "ambiguous", nodeIds: unique, rawText };
  }

  if (externDecls.length > 0) {
    // External library — derive a logical name from the import path of
    // any non-relative module specifier reaching this symbol.
    const externId = buildExternNodeId(call, target, resolved, externDecls, ctx);
    if (externId !== null) {
      return { kind: "resolved", nodeIds: [externId], rawText };
    }
    // External library with a visible callee name we could not turn into an
    // extern NodeId — visible, not a hidden bypass.
    return {
      kind: "unresolved",
      nodeIds: [],
      reason: "external-lib",
      rawText,
      nameHidden: false,
    };
  }

  return {
    kind: "unresolved",
    nodeIds: [],
    reason: "module-not-resolved",
    rawText,
    nameHidden: false,
  };
}

/**
 * Resolve a `super(...)` call by walking up from the call site to the
 * enclosing class, then resolving its `extends` clause to a parent
 * class declaration. The returned NodeId points at the parent's
 * explicit constructor when one exists; when the parent has no
 * explicit ctor we recurse; when the chain bottoms out at a built-in
 * (`Error`, `Object`, ...) we return resolved-with-no-edges so the
 * caller does not attribute mystery effects to it.
 *
 * `super(...)` is structurally unambiguous — under no circumstances
 * may we return `unresolved` here.
 */
function resolveSuperCall(
  call: ts.CallExpression,
  ctx: ExtractorContext,
  rawText: string,
): ResolvedCallee {
  const enclosingClass = findEnclosingClass(call);
  if (enclosingClass === null) {
    return { kind: "resolved", nodeIds: [], rawText };
  }
  const parentCtor = findInheritedConstructor(enclosingClass, ctx);
  if (parentCtor === null) {
    // Parent terminates at a built-in or has no in-project ctor.
    return { kind: "resolved", nodeIds: [], rawText };
  }
  const id = buildNodeIdForDeclaration(parentCtor as ts.FunctionLikeDeclaration, ctx);
  return { kind: "resolved", nodeIds: [id], rawText };
}

function findEnclosingClass(node: ts.Node): ts.ClassDeclaration | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur !== undefined) {
    if (ts.isClassDeclaration(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Walk the `extends` chain of a class declaration looking for the
 * nearest ancestor with an explicit constructor declared in an
 * in-project source file. Returns `null` when the chain terminates at
 * a built-in (no `extends`, or `extends` resolves to a declaration in
 * a `.d.ts` / `node_modules` file).
 */
function findInheritedConstructor(
  cls: ts.ClassDeclaration,
  ctx: ExtractorContext,
): ts.ConstructorDeclaration | null {
  if (cls.heritageClauses === undefined) return null;
  for (const heritage of cls.heritageClauses) {
    if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const baseTypeExpr of heritage.types) {
      const baseSymbol = ctx.checker.getSymbolAtLocation(baseTypeExpr.expression);
      if (baseSymbol === undefined) continue;
      const baseResolved = followAlias(baseSymbol, ctx.checker);
      const baseDecls = baseResolved.declarations ?? [];
      for (const bd of baseDecls) {
        if (!ts.isClassDeclaration(bd)) continue;
        const sf = bd.getSourceFile();
        if (sf.isDeclarationFile) return null;
        if (sf.fileName.includes("/node_modules/")) return null;
        if (!sf.fileName.startsWith(ctx.projectRoot)) return null;
        const ctor = bd.members.find((m) => ts.isConstructorDeclaration(m));
        if (ctor !== undefined) return ctor as ts.ConstructorDeclaration;
        // Parent also has no explicit ctor — recurse one level up.
        const grand = findInheritedConstructor(bd, ctx);
        if (grand !== null) return grand;
      }
    }
  }
  return null;
}

/**
 * Single-hop alias deref. When `decls` is exactly one VariableDeclaration of
 * the form `const x = <bare-identifier>` (the initializer is a plain
 * `Identifier`, NOT a call / arrow / function expression / property access),
 * resolve that identifier's symbol and return ITS declarations. Returns `null`
 * when the shape does not match, so the caller keeps the original decls.
 *
 * Conservative on purpose:
 *   - single declaration only (no ambiguous multi-decl symbols),
 *   - identifier initializer only (arrow/function expressions are handled by
 *     `dereferenceVariableBindings`; call expressions are runtime-unknown),
 *   - single hop (we do NOT recurse — a chain `const a = b; const b = c` only
 *     follows one step, matching the spec's "follow the alias one hop").
 */
function dereferenceIdentifierAlias(
  decls: readonly ts.Declaration[],
  ctx: ExtractorContext,
): ts.Declaration[] | null {
  if (decls.length !== 1) return null;
  const decl = decls[0]!;
  if (!ts.isVariableDeclaration(decl)) return null;
  const init = decl.initializer;
  if (init === undefined || !ts.isIdentifier(init)) return null;
  const aliasSymbol = ctx.checker.getSymbolAtLocation(init);
  if (aliasSymbol === undefined) return null;
  const target = followAlias(aliasSymbol, ctx.checker);
  const targetDecls = target.declarations ?? [];
  if (targetDecls.length === 0) return null;
  // Guard against a self-referential or no-op hop (the initializer resolved
  // back to the same variable declaration).
  if (targetDecls.length === 1 && targetDecls[0] === decl) return null;
  return [...targetDecls];
}

function detectDynamicDispatch(expr: ts.LeftHandSideExpression): "dynamic" | "reflection" | null {
  // `Reflect.apply(...)`, `Reflect.construct(...)` → reflection.
  if (ts.isPropertyAccessExpression(expr)) {
    const obj = expr.expression;
    if (ts.isIdentifier(obj) && obj.escapedText === "Reflect") {
      return "reflection";
    }
    // `obj.fn.apply()` / `obj.fn.call()` / `obj.fn.bind()` — these
    // ultimately call the function but indirectly; classify as dynamic.
    const name = expr.name.escapedText;
    if (name === "apply" || name === "call" || name === "bind") {
      // Only flag if the receiver of `.apply` is itself a function-like
      // chain such as `fn.apply(...)`. We deliberately do NOT block
      // `arr.map(...)` here — those resolve normally.
      const receiver = expr.expression;
      if (looksLikeFunctionRef(receiver)) {
        return "dynamic";
      }
    }
  }

  // `obj[name]()` — computed property access → dynamic.
  if (ts.isElementAccessExpression(expr)) {
    return "dynamic";
  }

  return null;
}

function looksLikeFunctionRef(node: ts.Node): boolean {
  // Heuristic: identifier or property access whose right side does NOT
  // look like a typical method invocation target. We're trying to flag
  // `someFn.apply(...)` but not `arr.map.apply(...)` (rare anyway).
  if (ts.isIdentifier(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return true;
  return false;
}

function getResolutionTarget(expr: ts.LeftHandSideExpression): ts.Node | null {
  if (ts.isIdentifier(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  if (ts.isParenthesizedExpression(expr)) return getResolutionTarget(expr.expression as ts.LeftHandSideExpression);
  // Call expressions like `getFn()()` — the inner call's return is
  // unknown statically.
  if (ts.isCallExpression(expr)) return null;
  if (ts.isNewExpression(expr)) return null;
  if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
    // IIFE — the body is the callee; we'd need a NodeId for the lambda
    // but that's outside MVP scope. Classify as dynamic.
    return null;
  }
  return null;
}

/**
 * When a declaration is a VariableDeclaration whose initializer is an
 * arrow function or function expression, replace it with the inner
 * function-like node. This lets `const foo = () => {}` show up as a
 * callable target.
 */
function dereferenceVariableBindings(decls: readonly ts.Declaration[]): ts.Declaration[] {
  const out: ts.Declaration[] = [];
  for (const d of decls) {
    if (ts.isVariableDeclaration(d) && d.initializer !== undefined) {
      const init = d.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        out.push(init);
        continue;
      }
    }
    if (ts.isPropertyDeclaration(d) && d.initializer !== undefined) {
      const init = d.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        out.push(init);
        continue;
      }
    }
    out.push(d);
  }
  return out;
}

/**
 * When the resolved declarations contain interface MethodSignatures or
 * abstract MethodDeclarations (no body), look up every concrete class
 * in the program that declares a method with the same name AND
 * implements/extends the interface or abstract class. Those concrete
 * impls become the in-project candidates (1 → resolved; ≥2 → ambiguous).
 *
 * When the input has no MethodSignatures at all, the original list is
 * returned unchanged.
 */
function expandInterfaceMethods(decls: readonly ts.Declaration[], ctx: ExtractorContext): ts.Declaration[] {
  let needsExpansion = false;
  for (const d of decls) {
    if (ts.isMethodSignature(d)) {
      needsExpansion = true;
      break;
    }
    if (ts.isMethodDeclaration(d) && d.body === undefined) {
      needsExpansion = true;
      break;
    }
  }
  if (!needsExpansion) return [...decls];

  const out: ts.Declaration[] = [];
  for (const d of decls) {
    const isAbstract = ts.isMethodSignature(d) || (ts.isMethodDeclaration(d) && d.body === undefined);
    if (!isAbstract) {
      out.push(d);
      continue;
    }
    if (d.name === undefined) continue;
    const methodName = d.name.getText();

    // Locate the parent interface / abstract class declaration.
    const parent = d.parent;
    if (
      parent === undefined ||
      (!ts.isInterfaceDeclaration(parent) && !ts.isClassDeclaration(parent))
    ) {
      continue;
    }
    if (parent.name === undefined) continue;
    const parentSymbol = ctx.checker.getSymbolAtLocation(parent.name);
    if (parentSymbol === undefined) continue;

    // Walk every source file and find classes that implement/extend
    // this interface or abstract class, then collect their methods.
    for (const sf of ctx.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue;
      if (sf.fileName.includes("/node_modules/")) continue;
      if (!sf.fileName.startsWith(ctx.projectRoot)) continue;

      sf.forEachChild(function walk(node: ts.Node): void {
        if (ts.isClassDeclaration(node) && node.heritageClauses !== undefined) {
          for (const heritage of node.heritageClauses) {
            for (const expr of heritage.types) {
              const heritageSymbol = ctx.checker.getSymbolAtLocation(expr.expression);
              if (heritageSymbol === undefined) continue;
              if (heritageSymbol === parentSymbol || followAlias(heritageSymbol, ctx.checker) === parentSymbol) {
                for (const member of node.members) {
                  if (
                    ts.isMethodDeclaration(member) &&
                    member.body !== undefined &&
                    member.name !== undefined &&
                    member.name.getText() === methodName
                  ) {
                    out.push(member);
                  }
                }
              }
            }
          }
        }
        node.forEachChild(walk);
      });
    }
  }
  return out;
}

function followAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function isFunctionLikeForNode(decl: ts.Declaration): boolean {
  return (
    ts.isFunctionDeclaration(decl) ||
    ts.isMethodDeclaration(decl) ||
    ts.isConstructorDeclaration(decl) ||
    ts.isGetAccessor(decl) ||
    ts.isSetAccessor(decl) ||
    ts.isArrowFunction(decl) ||
    ts.isFunctionExpression(decl)
  );
}

function uniqueSortedStrings(input: readonly string[]): string[] {
  return Array.from(new Set(input)).sort();
}

function buildExternNodeId(
  call: ts.CallExpression | ts.NewExpression,
  target: ts.Node,
  resolved: ts.Symbol,
  externDecls: readonly ts.Declaration[],
  ctx: ExtractorContext,
): string | null {
  // Strategy: find an import declaration whose binding contributes to
  // the resolved symbol; derive the logical name from the module
  // specifier. We walk back from the call site to the top of its file
  // to look at import declarations.
  const sourceFile = call.getSourceFile();
  const packageName = findPackageForSymbol(sourceFile, target, ctx);
  if (packageName === null) {
    // Fallback: use the declaration file's path (e.g.
    // node_modules/lodash/index.d.ts → "lodash").
    const inferred = inferPackageFromDeclFile(externDecls);
    if (inferred === null) return null;
    return makeExternNodeId(inferred, call, resolved, externDecls, ctx);
  }
  return makeExternNodeId(packageName, call, resolved, externDecls, ctx);
}

function findPackageForSymbol(
  sourceFile: ts.SourceFile,
  target: ts.Node,
  ctx: ExtractorContext,
): string | null {
  // Read the identifier text of the target.
  const targetName = target.getText();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const modulePath = stmt.moduleSpecifier.text;
    // Skip relative imports — they are in-project, not extern.
    if (modulePath.startsWith(".") || modulePath.startsWith("/")) continue;

    const clause = stmt.importClause;
    if (clause === undefined) continue;

    // Default import: `import lodash from "lodash"`
    if (clause.name !== undefined && clause.name.escapedText === targetName) {
      return logicalNameFromModulePath(modulePath, ctx);
    }
    // Named bindings: `import { fn, foo as bar } from "lodash"`
    if (clause.namedBindings !== undefined) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        if (clause.namedBindings.name.escapedText === targetName) {
          return logicalNameFromModulePath(modulePath, ctx);
        }
      }
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (el.name.escapedText === targetName) {
            return logicalNameFromModulePath(modulePath, ctx);
          }
        }
      }
    }
  }
  return null;
}

function logicalNameFromModulePath(modulePath: string, ctx: ExtractorContext): string {
  // Scoped: @scope/name → scope-name. Sub-path: foo/bar → foo.
  let base = modulePath;
  const slashIdx = base.indexOf("/");
  if (modulePath.startsWith("@") && slashIdx > 0) {
    const secondSlash = modulePath.indexOf("/", slashIdx + 1);
    base = secondSlash > 0 ? modulePath.slice(0, secondSlash) : modulePath;
  } else if (slashIdx > 0) {
    base = modulePath.slice(0, slashIdx);
  }

  // Apply registry reverse lookup if available so users can pin
  // canonical logical names via `(extern-alias ...)`.
  if (ctx.externAliasRegistry !== undefined) {
    const logical = ctx.externAliasRegistry.reverseLookup(base, "typescript");
    if (logical !== null) return logical;
  }

  return normalizeLogicalName(base);
}

function normalizeLogicalName(pkg: string): string {
  // Strip `@scope/` prefix and lowercase, replace illegal chars with `-`.
  let name = pkg;
  if (name.startsWith("@")) {
    name = name.slice(1).replace("/", "-");
  }
  name = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  // Logical names must start with a letter per node-id parser rules.
  if (!/^[a-z]/.test(name)) {
    name = "x-" + name;
  }
  return name;
}

function inferPackageFromDeclFile(externDecls: readonly ts.Declaration[]): string | null {
  for (const d of externDecls) {
    const fn = d.getSourceFile().fileName;
    const idx = fn.lastIndexOf("/node_modules/");
    if (idx < 0) continue;
    const rest = fn.slice(idx + "/node_modules/".length);
    const firstSlash = rest.indexOf("/");
    if (firstSlash < 0) continue;
    const head = rest.slice(0, firstSlash);
    if (head.startsWith("@")) {
      const secondSlash = rest.indexOf("/", firstSlash + 1);
      if (secondSlash > 0) return rest.slice(0, secondSlash);
      return head;
    }
    return head;
  }
  return null;
}

function makeExternNodeId(
  packageNameOrLogical: string,
  call: ts.CallExpression | ts.NewExpression,
  resolved: ts.Symbol,
  externDecls: readonly ts.Declaration[],
  ctx: ExtractorContext,
): string {
  const logical = normalizeLogicalName(packageNameOrLogical);
  // Apply registry reverse lookup again on the raw form (handles case
  // when caller passed a raw npm package name directly).
  let final = logical;
  if (ctx.externAliasRegistry !== undefined) {
    const reversed = ctx.externAliasRegistry.reverseLookup(packageNameOrLogical, "typescript");
    if (reversed !== null) final = reversed;
  }

  // Best-effort container + name: use the symbol name; container from
  // the first non-source declaration's parent class/interface if any.
  let container: string[] = [];
  let symbolName = resolved.getName();
  if (symbolName === "" || symbolName === undefined) {
    if (ts.isPropertyAccessExpression(call.expression)) {
      symbolName = call.expression.name.getText();
    } else if (ts.isIdentifier(call.expression)) {
      symbolName = call.expression.getText();
    } else {
      symbolName = "<unknown>";
    }
  }

  for (const decl of externDecls) {
    const parent = decl.parent;
    if (parent !== undefined && (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent))) {
      if (parent.name !== undefined) {
        container = [parent.name.getText()];
        break;
      }
    }
  }

  // Property access reveals receiver type: `client.charges.create(...)`
  // → receiver = `client.charges`. If the receiver has a checker-known
  // type with a symbol, use that as the container.
  if (container.length === 0 && ts.isPropertyAccessExpression(call.expression)) {
    const receiver = call.expression.expression;
    const recvType = ctx.checker.getTypeAtLocation(receiver);
    const recvSymbol = recvType.getSymbol();
    if (recvSymbol !== undefined && recvSymbol.getName() !== "" && recvSymbol.getName() !== "__type") {
      const recvName = recvSymbol.getName();
      // Strip leading underscores from internal names.
      if (recvName !== undefined && recvName !== "") {
        container = [recvName];
      }
    }
  }

  const arity = call.arguments?.length ?? 0;
  return formatNodeId({
    externLogicalName: final,
    container,
    symbolName,
    arity,
  });
}
