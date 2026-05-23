export class Stripe {
  create(charge: { amount: number; currency: string; source: string }): unknown {
    return { ok: true, charge };
  }
}

export const stripe = new Stripe();
