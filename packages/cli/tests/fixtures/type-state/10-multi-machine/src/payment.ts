export type PaymentState = "Pending" | "Authorized" | "Captured" | "Refunded";

export class Payment<S extends PaymentState = "Pending"> {
  declare readonly __state: S;

  authorize(): Payment<"Authorized"> {
    return this as unknown as Payment<"Authorized">;
  }

  capture(): Payment<"Captured"> {
    return this as unknown as Payment<"Captured">;
  }

  refund(): Payment<"Refunded"> {
    return this as unknown as Payment<"Refunded">;
  }
}

export function createPayment(): Payment<"Pending"> {
  return new Payment();
}
