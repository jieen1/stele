import type { Order, OrderState } from "./order.js";

/**
 * Parameter `o` is typed with the full state union `Order<OrderState>`, so
 * the backend extractor sees a union of phantom literals and cannot pick a
 * single state. With no `(type-state-binding ...)` covering this caller and
 * strictMode=true (default), the evaluator emits an inference_failed error.
 */
export function processOrder(o: Order<OrderState>): void {
  o.pay();
}
