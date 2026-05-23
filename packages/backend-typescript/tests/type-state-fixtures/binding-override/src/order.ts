export type OrderState =
  | "Draft"
  | "Submitted"
  | "Paid";

export interface Order<S extends OrderState> {
  readonly __state: S;
  charge(): Order<"Paid">;
  refund(): Order<S>;
  addItem(amount: number): Order<S>;
}
