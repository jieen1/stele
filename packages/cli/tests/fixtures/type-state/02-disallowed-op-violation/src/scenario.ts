import { createOrder } from "./order.js";

export function main(): void {
  const order = createOrder();
  order.addItem("a");
  const submitted = order.submit();
  const paid = submitted.pay();
  paid.addItem("b");
}
