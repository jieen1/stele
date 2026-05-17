import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Result of project directory validation.
 * Discriminated union: exactly one of `path` or `error` is present.
 */
export type ValidateProjectDirResult =
  | { path: string }
  | { error: string };

/**
 * Validate and resolve a project directory argument.
 *
 * Checks:
 * - Input is a non-empty string
 * - No Windows UNC paths
 * - Resolved path exists and is a directory
 * - Not a symlink
 */
export function validateProjectDir(raw: unknown): ValidateProjectDirResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { error: "projectDir must be a non-empty string" };
  }

  const resolved = resolve(raw.trim());

  // Reject Windows UNC paths (including namespace and admin shares)
  if (resolved.startsWith("//") || resolved.startsWith("\\\\")) {
    return { error: "UNC paths are not allowed" };
  }
  if (resolved.startsWith("\\\\?\\") || resolved.startsWith("//./") || resolved.startsWith("\\\\.\\admin")) {
    return { error: "Windows namespace paths are not allowed" };
  }

  // Reject symlinks + verify directory in single lstat call (no TOCTOU)
  try {
    const lstats = lstatSync(resolved);
    if (lstats.isSymbolicLink()) {
      return { error: "Symlinks are not allowed for projectDir" };
    }
    if (!lstats.isDirectory()) {
      return { error: `${resolved} is not a directory` };
    }
  } catch {
    return { error: `Path does not exist or is not accessible: ${resolved}` };
  }

  return { path: resolved };
}

/**
 * Quick version that throws on failure. Use for early bail.
 */
export function requireProjectDir(raw: unknown): string {
  const result = validateProjectDir(raw);
  if ("error" in result) {
    throw new Error(`Invalid projectDir: ${result.error}`);
  }
  return result.path;
}
