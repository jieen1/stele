// No @stele:effects tags anywhere in this fixture.

export function plain(): void {}

// Line comment style — must NOT be recognized by the extractor.
// @stele:effects db.read
export function lineCommented(): void {}

/**
 * A function with a regular JSDoc but no stele tag.
 * @param x — irrelevant.
 */
export function regularJsdoc(x: number): number {
  return x;
}

/** @stele:effects */
export function emptyAnnotation(): void {}
