export class Wallet {
  // Overload signatures share the impl — should map to ONE NodeId.
  debit(amount: string): void;
  debit(amount: number): void;
  debit(amount: string | number): void {
    void amount;
  }
}

export function run(): void {
  const w = new Wallet();
  w.debit(10);
}
