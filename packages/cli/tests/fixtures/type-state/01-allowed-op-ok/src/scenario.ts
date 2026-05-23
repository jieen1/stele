import { createOrder } from "./order.js";

export function main(): void {
  const order = createOrder();
  order.addItem("milk");
  order.addItem("bread");
}
