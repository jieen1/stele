export const doubled = (x: number): number => x * 2;

export function caller(): number {
  return doubled(5);
}

export function withArrow(): number {
  const local = (n: number): number => n + 1;
  return local(3);
}
