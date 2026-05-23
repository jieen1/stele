import type { Order, OrderState } from "./order.js";

/**
 * Same untyped-union parameter as fixture 07. With strictMode=false the
 * evaluator downgrades the inference_failed finding to a notice
 * (severity=warning) and keeps `violations` empty.
 */
export function processOrder(o: Order<OrderState>): void {
  o.pay();
}
