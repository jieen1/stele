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
