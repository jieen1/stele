/**
 * Phantom-typed Order class. The `S` type parameter encodes the lifecycle
 * state for the type-state inference extractor; runtime methods are no-ops
 * because the contract — not TypeScript's structural type system — is the
 * authoritative source of legality.
 *
 * Methods deliberately accept any phantom state at compile time so each
 * fixture's scenario file compiles cleanly; the contract is what catches
 * illegal sequences.
 */
export type OrderState =
  | "Draft"
  | "Submitted"
  | "Paid"
  | "Shipped"
  | "Cancelled"
  | "Refunded";

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

  ship(): Order<"Shipped"> {
    return this as unknown as Order<"Shipped">;
  }

  refund(): Order<"Refunded"> {
    return this as unknown as Order<"Refunded">;
  }
}

export function createOrder(): Order<"Draft"> {
  return new Order();
}
