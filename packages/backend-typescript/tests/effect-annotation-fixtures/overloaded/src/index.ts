export class Repo {
  // Two same-arity overloads of `find` — each carries its own JSDoc.
  // The extractor should union annotations from both signatures + impl
  // onto a single NodeId (overload sigs share the impl's NodeId).
  /** @stele:effects db.read */
  find(id: string): { id: string };
  /** @stele:effects log.write */
  find(token: number): { id: string };
  /** @stele:effects metrics.emit */
  find(arg: string | number): { id: string } {
    return { id: String(arg) };
  }

  /** @stele:effects db.read */
  count(): number {
    return 0;
  }

  /** @stele:effects db.read, log.write */
  countBy(field: string): number {
    return field.length;
  }
}
