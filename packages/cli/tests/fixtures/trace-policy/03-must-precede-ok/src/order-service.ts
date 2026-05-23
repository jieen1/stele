import { permissionService } from "./permission-service.js";
import { stripe } from "./stripe.js";

export class OrderService {
  pay(orderId: string): unknown {
    permissionService.verify(orderId);
    return stripe.create({ amount: 100, currency: "usd", source: orderId });
  }
}
