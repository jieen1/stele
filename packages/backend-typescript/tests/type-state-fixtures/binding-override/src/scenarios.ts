import type { Order, OrderState } from "./order.js";

// `pay` does NOT pin a concrete phantom state — phantom inference will fail
// (S is a generic parameter). A `(type-state-binding ...)` in the contract
// pins param 0 to "Submitted".
export function pay<S extends OrderState>(o: Order<S>, _amount: number): void {
  o.charge();
}

// Multi-param binding: receiver is the second parameter (index 1).
export function adjust<S extends OrderState>(_orderId: string, o: Order<S>): void {
  o.addItem(5);
}

// No binding, no annotation → inference must fail.
export function unannotated<S extends OrderState>(o: Order<S>): void {
  o.refund();
}
