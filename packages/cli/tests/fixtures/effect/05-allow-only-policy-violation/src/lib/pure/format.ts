import { findUser } from "../../db.js";
import { nowMs } from "../../clock.js";

/**
 * VIOLATION: `formatRecord` is in `src/lib/pure/**` but inherits db.read
 * via `findUser`. PURE_LIB_ONLY allows only `time.now`, so db.read is a
 * disallowed_effect.
 */
export function formatRecord(id: string): string {
  const user = findUser(id);
  return `${nowMs()}:${user.name}`;
}
