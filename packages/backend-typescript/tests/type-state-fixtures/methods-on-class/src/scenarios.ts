import { Order } from "./order.js";

export function externalCallSite(): void {
  const o = new Order<"Draft">();
  o.addItem(5);
}

export function viaFactory(): void {
  const o = Order.factory();
  o.addItem(5);
}
