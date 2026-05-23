/** @stele:effects db.* */
export function readAny(): void {}

/** @stele:effects payment.* , http.outgoing */
export function payAndCall(): void {}

/** @stele:effects DB.read, 1bad, ok.one, has space */
export function mixedValidity(): void {}

/** @stele:effects generic */
export function generic<T extends string>(x: T): T {
  return x;
}
