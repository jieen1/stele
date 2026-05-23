/**
 * Go-style separate-types representation: each state is its own struct/class
 * rather than a single phantom-typed class. The contract's
 * `(state-type-mapping ...)` enumerates the per-state targets and the
 * top-level `(target ...)` uses a glob like `src/order.ts::*Order`.
 */
export class DraftOrder {
  addItem(_item: string): void {
    /* no-op */
  }

  submit(): SubmittedOrder {
    return new SubmittedOrder();
  }
}

export class SubmittedOrder {
  pay(): PaidOrder {
    return new PaidOrder();
  }
}

export class PaidOrder {
  /* terminal */
}

export function createOrder(): DraftOrder {
  return new DraftOrder();
}
