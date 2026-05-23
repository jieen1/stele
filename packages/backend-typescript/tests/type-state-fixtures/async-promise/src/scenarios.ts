import { fetchPaidOrder } from "./order.js";

export async function awaitedReceiver(): Promise<void> {
  const o = await fetchPaidOrder();
  o.ship();
}
