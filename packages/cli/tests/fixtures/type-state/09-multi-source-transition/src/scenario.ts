import { createOrder } from "./order.js";

export function cancelFromDraft(): void {
  const order = createOrder();
  const cancelled = order.cancel();
  void cancelled;
}

export function cancelFromSubmitted(): void {
  const order = createOrder();
  const submitted = order.submit();
  const cancelled = submitted.cancel();
  void cancelled;
}
