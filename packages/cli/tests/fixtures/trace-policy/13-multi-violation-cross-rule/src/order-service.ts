import { stripe } from "./stripe.js";

// OrderService.pay violates three trace-policies at once:
//   - PAYMENT_PRECEDE  (missing PermissionService.verify before)
//   - PAYMENT_FOLLOW   (missing AuditLog.write after)
//   - PAYMENT_INDIRECT (direct call to Stripe.create from order-service)
export class OrderService {
  pay(orderId: string): unknown {
    return stripe.create({ amount: 100, currency: "usd", source: orderId });
  }
}
