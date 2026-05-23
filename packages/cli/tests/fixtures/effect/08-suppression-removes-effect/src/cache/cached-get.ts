import { findUser } from "../db.js";

/**
 * Cache wrapper. The CDL `(effect-suppression)` form removes db.read at
 * this exact NodeId, breaking the propagation chain to UI callers.
 */
export function cachedGet(id: string): { id: string; name: string } {
  return findUser(id);
}
