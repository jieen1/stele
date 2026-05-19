import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Compute the SHA-256 hex digest of a file's contents.
 */
export function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute the SHA-256 hex digest of a string.
 */
export function hashString(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
