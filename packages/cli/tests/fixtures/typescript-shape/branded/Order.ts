import type { InvoiceId } from "./InvoiceId.js";

export class Order {
  public readonly invoiceId: InvoiceId;

  private constructor(invoiceId: InvoiceId) {
    this.invoiceId = invoiceId;
  }

  static create(invoiceId: InvoiceId): Order {
    return new Order(invoiceId);
  }
}
