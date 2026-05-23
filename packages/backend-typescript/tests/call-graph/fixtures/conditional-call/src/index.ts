export function helper(): number {
  return 1;
}

export function caller(flag: boolean): number {
  if (flag) {
    return helper();
  }
  return 0;
}
