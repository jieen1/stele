export type OrderState =
  | "Draft"
  | "Submitted"
  | "Paid"
  | "Shipped"
  | "Cancelled";

export interface Order<S extends OrderState = "Draft"> {
  readonly __state: S;
  addItem(amount: number): Order<S>;
  charge(): Order<"Paid">;
  cancel(): Order<"Cancelled">;
  ship(): Order<"Shipped">;
  refund(): Order<S>;
}
