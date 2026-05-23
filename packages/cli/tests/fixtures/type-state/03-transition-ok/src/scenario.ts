import { createOrder } from "./order.js";

export function main(): void {
  const order = createOrder();
  const submitted = order.submit();
  const paid = submitted.pay();
  void paid;
}
