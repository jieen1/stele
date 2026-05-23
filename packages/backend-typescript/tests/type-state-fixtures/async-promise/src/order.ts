export type OrderState = "Draft" | "Submitted" | "Paid";

export interface Order<S extends OrderState = "Draft"> {
  readonly __state: S;
  ship(): Order<"Paid">;
}

export async function fetchPaidOrder(): Promise<Order<"Paid">> {
  return null as unknown as Order<"Paid">;
}
