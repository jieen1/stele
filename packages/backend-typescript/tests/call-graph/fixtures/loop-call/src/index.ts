export function tick(): void {}

export function caller(): void {
  for (let i = 0; i < 3; i++) {
    tick();
  }
}
