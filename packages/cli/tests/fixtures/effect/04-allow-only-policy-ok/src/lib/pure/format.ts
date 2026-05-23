import { nowMs } from "../../clock.js";

/**
 * `formatNow` calls `nowMs` (declares time.now). PURE_LIB_ONLY allows
 * exactly time.now, so this is OK.
 */
export function formatNow(): string {
  return String(nowMs());
}
