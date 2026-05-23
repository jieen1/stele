import { Charges } from "stripe";

export async function pay(): Promise<string> {
  const c = new Charges();
  const result = await c.create({ amount: 100, currency: "usd" });
  return result.id;
}
