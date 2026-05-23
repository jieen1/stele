import { stripe } from "./stripe.js";

export class OrderService {
  pay(orderId: string): unknown {
    // Intentionally missing AuditLog.write after Stripe.create.
    return stripe.create({ amount: 100, currency: "usd", source: orderId });
  }
}
