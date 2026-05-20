export class PublicKey {
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  static fromPEM(pem: string): PublicKey {
    return new PublicKey(pem);
  }

  getKey(): string {
    return this.key;
  }
}
