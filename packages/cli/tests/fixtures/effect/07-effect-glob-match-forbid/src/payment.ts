/** @stele:effects payment.charge */
export function charge(amount: number): { id: string; amount: number } {
  return { id: "ch_1", amount };
}

/** @stele:effects payment.refund */
export function refund(id: string): { id: string } {
  return { id };
}
