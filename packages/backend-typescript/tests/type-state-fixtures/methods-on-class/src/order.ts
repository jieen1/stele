export type OrderState = "Draft" | "Submitted" | "Paid";

export class Order<S extends OrderState> {
  readonly __state!: S;
  addItem(_amount: number): Order<S> {
    // `this` inside this method is `Order<S>` — unbound generic.
    this.touch();
    return this;
  }
  touch(): Order<S> {
    return this;
  }
  ship(): Order<"Paid"> {
    return null as unknown as Order<"Paid">;
  }
  static factory(): Order<"Draft"> {
    return new Order<"Draft">();
  }
}
