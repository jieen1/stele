export type OrderState = "Draft" | "Submitted" | "Paid" | "Cancelled";

export class Order<S extends OrderState = "Draft"> {
  declare readonly __state: S;

  addItem(_item: string): void {
    /* no-op */
  }

  submit(): Order<"Submitted"> {
    return this as unknown as Order<"Submitted">;
  }

  pay(): Order<"Paid"> {
    return this as unknown as Order<"Paid">;
  }

  cancel(): Order<"Cancelled"> {
    return this as unknown as Order<"Cancelled">;
  }
}

export function createOrder(): Order<"Draft"> {
  return new Order();
}
