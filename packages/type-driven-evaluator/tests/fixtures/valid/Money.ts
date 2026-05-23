export class Money {
  private readonly amount: number;
  private readonly currency: string;

  private constructor(amount: number, currency: string) {
    this.amount = amount;
    this.currency = currency;
  }

  static parse(value: string): Money {
    const [amount, currency] = value.split(" ");
    return new Money(Number(amount), currency);
  }

  static create(amount: number, currency: string): Money {
    return new Money(amount, currency);
  }

  getAmount(): number {
    return this.amount;
  }

  getCurrency(): string {
    return this.currency;
  }
}
