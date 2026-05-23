import type { Order, OrderState } from "./order.js";

/**
 * Parameter `o` is typed with the full state union `Order<OrderState>`, so
 * the backend extractor sees a union of literal phantom states and cannot
 * pick a single one — that normally triggers an inference_failed finding.
 *
 * The `(type-state-binding (function processOrder(1)) (param 0 state Submitted))`
 * declaration covers this caller, so the evaluator suppresses the
 * inference_failed finding. Expected outcome: 0 violations and 0 notices.
 */
export function processOrder(o: Order<OrderState>): void {
  o.pay();
}
