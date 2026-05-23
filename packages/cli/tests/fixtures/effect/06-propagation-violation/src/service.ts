import { findUser } from "./db.js";

/**
 * Intermediate service — no source-level annotation. Effect propagation
 * gives this function db.read inherited from `findUser`.
 */
export function getUserProfile(id: string): { id: string; name: string } {
  return findUser(id);
}
