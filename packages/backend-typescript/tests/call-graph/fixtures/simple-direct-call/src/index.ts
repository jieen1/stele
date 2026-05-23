export function callee(x: number): number {
  return x + 1;
}

export function caller(): number {
  return callee(2);
}
