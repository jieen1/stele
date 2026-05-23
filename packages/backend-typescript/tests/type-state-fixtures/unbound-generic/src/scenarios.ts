import type { Order, OrderState } from "./order.js";

export function unboundGeneric<S extends OrderState>(o: Order<S>): void {
  o.noop();
}

// Equivalent unbound-state path: any state allowed, no concrete pin.
export function missingTypeArg<S extends OrderState>(o: Order<S>): void {
  o.noop();
}
