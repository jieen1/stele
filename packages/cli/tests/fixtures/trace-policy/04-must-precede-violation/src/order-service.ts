import { stripe } from "./stripe.js";

export class OrderService {
  pay(orderId: string): unknown {
    // Intentionally missing PermissionService.verify before Stripe.create.
    return stripe.create({ amount: 100, currency: "usd", source: orderId });
  }
}
