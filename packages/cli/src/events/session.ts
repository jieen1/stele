import { randomBytes } from "node:crypto";

export function generateSessionId(): string {
  return randomBytes(8).toString("hex");
}
