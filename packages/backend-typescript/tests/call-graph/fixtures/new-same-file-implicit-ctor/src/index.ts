interface Registry {
  put(k: string, v: number): void;
}

class InMemoryRegistry implements Registry {
  readonly #data = new Map<string, number>();
  put(k: string, v: number): void {
    this.#data.set(k, v);
  }
}

export function makeRegistry(): Registry {
  return new InMemoryRegistry();
}
