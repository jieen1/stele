import { findUser, saveUser } from "./db.js";
import { getJson } from "./http.js";

export function main(): void {
  const u = findUser("a");
  saveUser(u);
  getJson("https://example.test");
}
