import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sha256Branded, type Sha256 } from "@stele/core";

/**
 * Compute the SHA-256 hex digest of a file's contents.
 */
export function hashFile(filePath: string): Sha256 {
  const content = readFileSync(filePath);
  return sha256Branded(createHash("sha256").update(content).digest("hex"));
}

/**
 * Compute the SHA-256 hex digest of a string.
 */
export function hashString(content: string): Sha256 {
  return sha256Branded(createHash("sha256").update(content).digest("hex"));
}
