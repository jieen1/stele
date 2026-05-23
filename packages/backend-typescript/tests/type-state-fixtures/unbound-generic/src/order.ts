export type OrderState = "Draft" | "Submitted" | "Paid";

export interface Order<S extends OrderState> {
  readonly __state: S;
  noop(): Order<S>;
}
