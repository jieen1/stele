interface Tools {
  [key: string]: () => void;
}

const tools: Tools = {
  a: () => undefined,
  b: () => undefined,
};

export function callDynamic(name: string): void {
  tools[name]();
}

export function callReflect(fn: (...args: unknown[]) => unknown): unknown {
  return Reflect.apply(fn, undefined, []);
}

// Name-VISIBLE indirect call: the callee identifier `predicate` is statically
// visible. The symbol is a param (no in-project declaration to resolve to), so
// it lands in `unresolvedCalls`, but with `nameHidden: false` — it provably
// cannot be a hidden bypass of a named trace target.
export function callVisibleParam(predicate: () => boolean): boolean {
  return predicate();
}

// Name-HIDDEN dynamic import: the `import(...)` call itself has no
// statically-recoverable callee name → `nameHidden: true`.
export async function callDynamicImport(): Promise<unknown> {
  return import("node:fs");
}
