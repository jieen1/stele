export class Order {
  /** @stele:effects db.write */
  constructor(public readonly id: string) {}

  /** @stele:effects db.read */
  load(): void {}

  /** @stele:effects db.write, log.write */
  save(): void {}

  /** @stele:effects time.now */
  static now(): number {
    return 0;
  }

  // unannotated
  helper(): void {}
}
