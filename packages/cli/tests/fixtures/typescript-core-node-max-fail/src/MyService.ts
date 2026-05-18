export class MyService {
  private readonly id: number;
  private readonly name: string;
  private active: boolean;

  constructor() {
    this.id = Math.random();
    this.name = "MyService";
    this.active = true;
  }

  process(data: string): string {
    if (!data) {
      throw new Error("empty");
    }
    const result = data.toUpperCase();
    return result.trim();
  }

  validate(data: string): boolean {
    if (!data || data.length === 0) {
      return false;
    }
    if (data.length >= 100) {
      return false;
    }
    return true;
  }

  getInfo(): { id: number; name: string } {
    return { id: this.id, name: this.name };
  }

  isActive(): boolean {
    return this.active;
  }

  activate(): void {
    this.active = true;
  }

  deactivate(): void {
    this.active = false;
  }
}
