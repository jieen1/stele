export function a(): number {
  return b();
}

export function b(): number {
  return c();
}

export function c(): number {
  return 42;
}
