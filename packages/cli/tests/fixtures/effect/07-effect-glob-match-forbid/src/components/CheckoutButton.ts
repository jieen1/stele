import { charge } from "../payment.js";

/**
 * VIOLATION: CheckoutButton calls `charge` (payment.charge). The
 * NO_PAYMENT_IN_UI policy uses the `payment.*` glob, which expands to all
 * declared payment effects.
 */
export function CheckoutButton(props: { amount: number }): string {
  const result = charge(props.amount);
  return `<button>${result.id}</button>`;
}
