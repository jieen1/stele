export class Order {
  pay(amount: number): void {
    this.log(amount);
  }

  log(value: number): void {
    void value;
  }
}

export function run(): void {
  const o = new Order();
  o.pay(10);
}
