export class MyService {
  private readonly id: number;

  constructor() {
    this.id = Math.random();
  }

  process(data: string): string {
    if (!data) {
      throw new Error("empty");
    }
    return data.toUpperCase();
  }

  validate(data: string): boolean {
    return data.length > 0 && data.length < 100;
  }

  getInfo(): { id: number; name: string } {
    return { id: this.id, name: "MyService" };
  }
}
