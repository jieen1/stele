import type { Order } from "./order.js";

export function paySubmitted(o: Order<"Submitted">): void {
  o.charge();
}

export function processInner(o: Order<"Submitted">): void {
  helper(o);
}

export function helper(o: Order<"Submitted">): void {
  // Inside helper, o is annotated as Submitted — direct inference still works
  // for this call. The cross-function flow (from processInner) is NOT what's
  // tested here; we test that the annotation on `helper`'s parameter is
  // honored within its own body.
  o.charge();
}

export function genericHelper<S extends "Draft" | "Submitted" | "Paid">(o: Order<S>): void {
  // S is unbound — inference must fail.
  o.refund();
}
