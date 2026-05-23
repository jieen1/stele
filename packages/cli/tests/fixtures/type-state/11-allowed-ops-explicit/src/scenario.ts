import { createOrder } from "./order.js";

export function main(): void {
  const order = createOrder();
  const submitted = order.submit();
  submitted.addItem("late-but-explicitly-allowed");
}
