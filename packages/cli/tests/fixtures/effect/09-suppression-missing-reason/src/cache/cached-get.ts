import { findUser } from "../db.js";

export function cachedGet(id: string): { id: string; name: string } {
  return findUser(id);
}
