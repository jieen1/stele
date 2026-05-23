export class Box<T> {
  constructor(public value: T) {}

  get(): T {
    return this.value;
  }
}

export function make(): Box<string> {
  return new Box<string>("hello");
}

export function useBox(): string {
  const b = make();
  return b.get();
}
