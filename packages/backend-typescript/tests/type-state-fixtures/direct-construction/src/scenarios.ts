import { createOrder, submit, pay } from "./order.js";

export function scenarioCreate(): void {
  const o = createOrder();
  o.addItem(10);
}

export function scenarioSubmittedFromChain(): void {
  const submitted = submit(createOrder());
  submitted.pay();
}

export function scenarioAnnotated(): void {
  const o = submit(createOrder());
  o.cancel();
}

export function scenarioDirectAfterPay(): void {
  const paid = pay(submit(createOrder()));
  paid.ship();
}
