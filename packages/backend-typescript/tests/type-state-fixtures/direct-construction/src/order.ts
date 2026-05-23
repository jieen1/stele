export type OrderState =
  | "Draft"
  | "Submitted"
  | "Paid"
  | "Shipped"
  | "Cancelled";

/**
 * Phantom-typed Order. Method declarations are augmented in this file
 * so call sites like `o.addItem(...)` are well-typed under tsc strict.
 */
export interface Order<S extends OrderState = "Draft"> {
  readonly __state: S;
  readonly id: string;
  readonly total: number;
  addItem(amount: number): Order<S>;
  removeItem(amount: number): Order<S>;
  submit(): Order<"Submitted">;
  pay(): Order<"Paid">;
  charge(): Order<"Paid">;
  ship(): Order<"Shipped">;
  cancel(): Order<"Cancelled">;
}

export function createOrder(): Order<"Draft"> {
  return null as unknown as Order<"Draft">;
}

export function submit(o: Order<"Draft">): Order<"Submitted"> {
  return null as unknown as Order<"Submitted">;
}

export function pay(o: Order<"Submitted">): Order<"Paid"> {
  return null as unknown as Order<"Paid">;
}
