import { createOrder } from "./order.js";
import { createPayment } from "./payment.js";

export function main(): void {
  const order = createOrder();
  const submitted = order.submit();
  void submitted.pay();

  const payment = createPayment();
  const authorized = payment.authorize();
  void authorized.capture();
}
