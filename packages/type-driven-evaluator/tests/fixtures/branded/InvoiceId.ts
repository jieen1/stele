export type InvoiceId = string & { readonly brand: "InvoiceId" };

export function createInvoiceId(value: string): InvoiceId {
  return value as InvoiceId;
}
