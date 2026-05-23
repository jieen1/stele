/** @stele:effects db.read, db.write */
export function writeUser(id: string): void {}

/**
 * Read a user via an external HTTP call.
 *
 * @stele:effects http.outgoing,    db.read
 */
export async function fetchUser(id: string): Promise<{ id: string }> {
  return { id };
}

/**
 * Trailing whitespace and varied spacing.
 * @stele:effects   payment.charge   ,   log.write
 */
export function chargeAndLog(amount: number): void {}
