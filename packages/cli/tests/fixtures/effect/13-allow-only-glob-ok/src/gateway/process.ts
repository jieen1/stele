import { charge, refund } from "../payment.js";

/**
 * Gateway code performs payment.charge + payment.refund.
 * `allow-only "payment.*"` glob-expands to both, so this is OK.
 */
export function processCharge(amount: number): { id: string } {
  const c = charge(amount);
  return c;
}

export function processRefund(id: string): { id: string } {
  return refund(id);
}
