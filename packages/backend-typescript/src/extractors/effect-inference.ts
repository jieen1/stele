/**
 * Type-checker-backed effect INFERENCE for TypeScript.
 *
 * Companion to `effect-annotations.ts`. Where that module reads effects
 * the author *declared* via `@stele:effects` JSDoc, this module infers
 * the effects a function body *actually performs* by resolving calls and
 * property accesses through the `ts.TypeChecker` and matching them
 * against the Node builtin / lib-global surface.
 *
 * This makes effect-policy SOUND: a function that does a real effectful
 * operation (fetch, fs write, child_process, Math.random, Date.now,
 * process.env, …) gets that effect even without an annotation.
 *
 * The inference is INTENTIONALLY conservative: it only attributes an
 * effect when the resolved symbol's declaration lives in `node_modules`
 * (e.g. `@types/node`) or in a TypeScript `lib.*.d.ts`, AND the
 * simple/qualified name matches a known builtin. If a call cannot be
 * confidently resolved to a builtin, NOTHING is returned for it —
 * a false positive (a wrong effect on real user code) is worse than a
 * miss, because it would block correct code.
 *
 * The walk is SHALLOW with respect to function-like nodes: it does NOT
 * descend into nested function/arrow/method declarations, which are
 * separate nodes with their own inference. Everything else (loops,
 * branches, expressions, awaits) is traversed.
 *
 * The returned set is restricted to this exact declared vocabulary:
 *
 *   fs.read, fs.write, time, random, env, network, crypto.hash,
 *   process, child-process
 */

import * as ts from "typescript";

/** The closed effect vocabulary this inference can emit. */
type InferredEffect =
  | "fs.read"
  | "fs.write"
  | "time"
  | "random"
  | "env"
  | "network"
  | "crypto.hash"
  | "process"
  | "child-process";

const FS_WRITE_NAMES: ReadonlySet<string> = new Set([
  "writeFile", "writeFileSync",
  "appendFile", "appendFileSync",
  "mkdir", "mkdirSync",
  "rm", "rmSync",
  "rmdir", "rmdirSync",
  "unlink", "unlinkSync",
  "rename", "renameSync",
  "copyFile", "copyFileSync",
  "cp", "cpSync",
  "truncate", "truncateSync",
  "ftruncate",
  "chmod", "chmodSync",
  "chown", "chownSync",
  "symlink", "symlinkSync",
  "link", "linkSync",
  "createWriteStream",
  "open", "openSync",
  "writev",
]);

const FS_READ_NAMES: ReadonlySet<string> = new Set([
  "readFile", "readFileSync",
  "readdir", "readdirSync",
  "stat", "statSync",
  "lstat", "lstatSync",
  "fstat", "fstatSync",
  "access", "accessSync",
  "exists", "existsSync",
  "realpath", "realpathSync",
  "readlink", "readlinkSync",
  "createReadStream",
  "opendir", "opendirSync",
  "watch", "watchFile",
  "read",
]);

const CHILD_PROCESS_NAMES: ReadonlySet<string> = new Set([
  "exec", "execSync",
  "execFile", "execFileSync",
  "spawn", "spawnSync",
  "fork",
]);

const CRYPTO_RANDOM_NAMES: ReadonlySet<string> = new Set([
  "randomBytes",
  "randomUUID",
  "randomInt",
  "randomFill", "randomFillSync",
  "generateKey", "generateKeySync",
  "generateKeyPair", "generateKeyPairSync",
  "getRandomValues",
]);

const CRYPTO_HASH_NAMES: ReadonlySet<string> = new Set([
  "createHash",
  "createHmac",
]);

/** Module specifiers (with/without the `node:` prefix) for fs. */
const FS_MODULES: ReadonlySet<string> = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises",
]);
const CHILD_PROCESS_MODULES: ReadonlySet<string> = new Set([
  "child_process", "node:child_process",
]);
const CRYPTO_MODULES: ReadonlySet<string> = new Set([
  "crypto", "node:crypto",
]);
const NETWORK_MODULES: ReadonlySet<string> = new Set([
  "http", "node:http",
  "https", "node:https",
  "http2", "node:http2",
  "net", "node:net",
  "dgram", "node:dgram",
  "dns", "node:dns", "dns/promises", "node:dns/promises",
  "tls", "node:tls",
]);

/** Global network constructors / functions (resolved via lib.dom or @types/node web-globals). */
const NETWORK_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
]);

/**
 * Infer the effects directly performed by `decl`'s body.
 *
 * Returns a deduplicated, first-seen-ordered list drawn from the closed
 * vocabulary above. Returns `[]` when the body is absent (e.g. an
 * overload signature or ambient declaration).
 */
export function inferEffectsFromBody(
  decl: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): string[] {
  const body = decl.body;
  if (body === undefined) return [];

  const seen = new Set<InferredEffect>();
  const out: InferredEffect[] = [];
  const add = (e: InferredEffect): void => {
    if (seen.has(e)) return;
    seen.add(e);
    out.push(e);
  };

  const walk = (node: ts.Node): void => {
    // SHALLOW: do not descend into nested function-like declarations —
    // they own their own inference. (The body Block itself is not a
    // function-like node, so the top-level call is fine.)
    if (node !== body && isFunctionLikeDeclaration(node)) {
      return;
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const e = effectForCallLike(node, checker);
      if (e !== null) add(e);
    } else if (ts.isPropertyAccessExpression(node)) {
      const e = effectForPropertyAccess(node, checker);
      if (e !== null) add(e);
    }

    ts.forEachChild(node, walk);
  };
  walk(body);

  return out;
}

/**
 * Resolve a CallExpression / NewExpression callee to a builtin effect,
 * or null if it isn't a confidently-resolved builtin.
 */
function effectForCallLike(
  node: ts.CallExpression | ts.NewExpression,
  checker: ts.TypeChecker,
): InferredEffect | null {
  const callee = node.expression;
  const argCount = node.arguments?.length ?? 0;

  // The name node carries the symbol: for `fs.writeFileSync(...)` the
  // method name; for a bare `writeFileSync(...)` the identifier itself.
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  const simpleName = ts.isIdentifier(nameNode)
    ? nameNode.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  if (simpleName === undefined) return null;

  const sym = resolveSymbol(nameNode, checker);

  // --- Lib globals that don't need a node_modules import -------------
  // Math.random, Date.now, new Date(), performance.now, process.hrtime.
  // These resolve to lib.*.d.ts; handle them by qualified-name shape
  // plus a builtin-origin check.
  if (ts.isPropertyAccessExpression(callee)) {
    const obj = callee.expression;
    if (ts.isIdentifier(obj)) {
      const objName = obj.text;
      // Math.random()
      if (objName === "Math" && simpleName === "random" && isBuiltinOriginSym(sym)) {
        return "random";
      }
      // Date.now()
      if (objName === "Date" && simpleName === "now" && isBuiltinOriginSym(sym)) {
        return "time";
      }
      // performance.now()
      if (objName === "performance" && simpleName === "now" && isBuiltinOriginSym(sym)) {
        return "time";
      }
      // process.hrtime() / process.hrtime.bigint() handled in process block below.
    }
    // process.hrtime.bigint() — callee.expression is `process.hrtime`.
    if (
      ts.isPropertyAccessExpression(obj) &&
      ts.isIdentifier(obj.expression) &&
      obj.expression.text === "process" &&
      obj.name.text === "hrtime" &&
      isProcessGlobal(obj.expression, checker)
    ) {
      return "time";
    }
  }

  // new Date() / Date() with ZERO args → clock read. With args it's a
  // pure date construction, not an effect.
  if (
    ts.isIdentifier(callee) &&
    callee.text === "Date" &&
    argCount === 0 &&
    isBuiltinOriginSym(sym)
  ) {
    return "time";
  }

  // --- process.* calls (cwd, exit, kill, chdir, nextTick, hrtime, …) -
  // Resolve the receiver to the node `process` global.
  if (ts.isPropertyAccessExpression(callee)) {
    const procEffect = processCallEffect(callee, checker);
    if (procEffect !== null) return procEffect;
  }

  // Everything below requires the resolved symbol to originate from a
  // builtin declaration file (node_modules / lib.*.d.ts). This is the
  // guard that prevents false positives on user methods that merely
  // share a name (e.g. `this.writeFileSync()`).
  if (!isBuiltinOriginSym(sym)) return null;

  const moduleName = builtinModuleOfSymbol(sym);

  // Global network constructors / functions (fetch, WebSocket, …).
  if (NETWORK_GLOBAL_NAMES.has(simpleName) && ts.isIdentifier(callee)) {
    return "network";
  }

  // The module/effect blocks below REQUIRE that the resolved symbol maps
  // to a concrete `@types/node` module (`moduleName !== null`). We do NOT
  // fall back to name-only matching when the module is unknown: a method
  // like `regex.exec(...)` or `array.read(...)` resolves to a lib global
  // (lib.es5.d.ts) with no node module, and a name-only match there would
  // mis-attribute `child-process` / `fs.read`. False negatives are
  // acceptable; false positives on real code are not.

  // node:fs
  if (moduleName !== null && FS_MODULES.has(moduleName)) {
    if (FS_WRITE_NAMES.has(simpleName)) return "fs.write";
    if (FS_READ_NAMES.has(simpleName)) return "fs.read";
  }
  // node:child_process
  if (moduleName !== null && CHILD_PROCESS_MODULES.has(moduleName)) {
    if (CHILD_PROCESS_NAMES.has(simpleName)) return "child-process";
  }
  // node:crypto
  if (moduleName !== null && CRYPTO_MODULES.has(moduleName)) {
    if (CRYPTO_HASH_NAMES.has(simpleName)) return "crypto.hash";
    if (CRYPTO_RANDOM_NAMES.has(simpleName)) return "random";
  }
  // node:http / https / net / dgram / dns / tls / http2
  if (moduleName !== null && NETWORK_MODULES.has(moduleName)) {
    return "network";
  }

  // `crypto.getRandomValues(...)` global (Web Crypto) — base is `crypto`.
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "crypto" &&
    simpleName === "getRandomValues"
  ) {
    return "random";
  }

  return null;
}

/**
 * Resolve a PropertyAccessExpression (NOT a call) to a builtin effect.
 * Today only `process.env` (any access under it) → `env`, and other
 * `process.<prop>` value reads (argv, pid, platform) → `process`.
 */
function effectForPropertyAccess(
  node: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): InferredEffect | null {
  // Avoid double-counting: if this access is itself the callee of a
  // CallExpression, the call handler covers it.
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
    return null;
  }
  // Walk to the root identifier of the access chain.
  const root = rootIdentifierOf(node);
  if (root === undefined || root.text !== "process") return null;
  if (!isProcessGlobal(root, checker)) return null;

  // Determine the first property after `process`.
  const firstProp = firstPropertyAfterRoot(node);
  if (firstProp === "env") return "env";
  // process.stdout.write / process.stderr.write are calls, handled
  // elsewhere; a bare value read of any other process.* is `process`.
  return "process";
}

/**
 * `process.<method>(...)` call effects. Returns `env` for any call
 * underneath `process.env`, else `process` for a recognised process
 * global call, else null.
 */
function processCallEffect(
  callee: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): InferredEffect | null {
  const root = rootIdentifierOf(callee);
  if (root === undefined || root.text !== "process") return null;
  if (!isProcessGlobal(root, checker)) return null;
  const firstProp = firstPropertyAfterRoot(callee);
  if (firstProp === "env") return "env";
  return "process";
}

/** Resolve a node to its symbol, following alias chains. */
function resolveSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let sym = checker.getSymbolAtLocation(node);
  if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* leave the alias symbol as-is */
    }
  }
  return sym;
}

/**
 * True when the symbol's declarations all originate from a builtin
 * surface: a file inside `node_modules` (e.g. `@types/node`) or a
 * TypeScript `lib.*.d.ts`. A symbol with at least one declaration in a
 * non-builtin file (user code) is NOT treated as a builtin.
 */
function isBuiltinOriginSym(sym: ts.Symbol | undefined): boolean {
  if (sym === undefined) return false;
  const decls = sym.getDeclarations();
  if (decls === undefined || decls.length === 0) return false;
  for (const d of decls) {
    if (!isBuiltinSourceFile(d.getSourceFile().fileName)) return false;
  }
  return true;
}

function isBuiltinSourceFile(fileName: string): boolean {
  const posix = fileName.split("\\").join("/");
  if (posix.includes("/node_modules/")) return true;
  // TypeScript bundled libs: `.../typescript/lib/lib.es5.d.ts`, etc.
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  if (base.startsWith("lib.") && base.endsWith(".d.ts")) return true;
  return false;
}

/**
 * Best-effort module specifier for a symbol resolved from a builtin
 * declaration. We read the source file path and map known `@types/node`
 * filenames back to their module name. Returns null when we can't tell
 * (the caller then relies on name + builtin-origin only).
 */
function builtinModuleOfSymbol(sym: ts.Symbol | undefined): string | null {
  if (sym === undefined) return null;
  const decls = sym.getDeclarations() ?? [];
  for (const d of decls) {
    const fileName = d.getSourceFile().fileName.split("\\").join("/");
    if (!fileName.includes("/@types/node/")) continue;
    const rel = fileName.slice(fileName.indexOf("/@types/node/") + "/@types/node/".length);
    // e.g. "fs.d.ts", "fs/promises.d.ts", "child_process.d.ts".
    const noExt = rel.replace(/\.d\.ts$/, "");
    return `node:${noExt}`;
  }
  return null;
}

function rootIdentifierOf(node: ts.PropertyAccessExpression): ts.Identifier | undefined {
  let cur: ts.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? cur : undefined;
}

/** The property name immediately after the root identifier in the chain. */
function firstPropertyAfterRoot(node: ts.PropertyAccessExpression): string | undefined {
  // Collect the chain bottom-up, then read element [1] (root is [0]).
  const names: string[] = [];
  let cur: ts.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) {
    names.unshift(cur.name.text);
    cur = cur.expression;
  }
  return names[0];
}

/**
 * True when `process` here is the Node global (declared in @types/node /
 * lib), not a user variable shadowing the name.
 */
function isProcessGlobal(processIdent: ts.Identifier, checker: ts.TypeChecker): boolean {
  const sym = resolveSymbol(processIdent, checker);
  return isBuiltinOriginSym(sym);
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
