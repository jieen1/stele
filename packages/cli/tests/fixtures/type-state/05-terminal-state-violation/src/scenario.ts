import { createOrder } from "./order.js";

export function main(): void {
  const order = createOrder();
  const cancelled = order.cancel();
  cancelled.addItem("late");
}
