export class BadOrder {
  public readonly invoiceId: string;

  constructor(invoiceId: string) {
    this.invoiceId = invoiceId;
  }

  setInvoice(invoiceId: string): void {
    this.invoiceId = invoiceId;
  }
}
