/**
 * @stele:effects db.read
 * @stele:effects http.outgoing
 */
export function twoTags(): void {}

/**
 * @stele:effects db.read, db.read, http.outgoing
 */
export function duplicateInOneTag(): void {}

/**
 * @stele:effects db.read
 * @stele:effects db.read
 */
export function sameTagTwice(): void {}
