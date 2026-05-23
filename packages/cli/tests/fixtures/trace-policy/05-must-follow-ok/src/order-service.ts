import { auditLog } from "./audit-log.js";
import { stripe } from "./stripe.js";

export class OrderService {
  pay(orderId: string): unknown {
    const result = stripe.create({ amount: 100, currency: "usd", source: orderId });
    auditLog.write(`charge: ${orderId}`);
    return result;
  }
}
