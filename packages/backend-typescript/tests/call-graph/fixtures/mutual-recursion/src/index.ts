export function isEven(n: number): boolean {
  if (n === 0) return true;
  return isOdd(n - 1);
}

export function isOdd(n: number): boolean {
  if (n === 0) return false;
  return isEven(n - 1);
}
