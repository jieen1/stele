export class Order {
  private readonly id: string;
  private readonly items: string[];

  protected constructor(id: string, items: string[]) {
    this.id = id;
    this.items = items;
  }

  static create(id: string, items: string[]): Order {
    return new Order(id, items);
  }

  getId(): string {
    return this.id;
  }

  getItems(): string[] {
    return this.items;
  }
}
