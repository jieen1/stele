import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Result of project directory validation.
 */
export interface ValidateProjectDirResult {
  /** Resolved absolute path, or undefined if validation failed. */
  path?: string;
  /** Error message if validation failed. */
  error?: string;
}

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

  // Reject Windows UNC paths
  if (resolved.startsWith("//") || resolved.startsWith("\\\\")) {
    return { error: "UNC paths are not allowed" };
  }

  // Check the path exists
  if (!existsSync(resolved)) {
    return { error: `Path does not exist: ${resolved}` };
  }

  // Reject symlinks (symlink attack prevention)
  try {
    const lstat = statSync(resolved);
    if (lstat.isSymbolicLink()) {
      return { error: "Symlinks are not allowed for projectDir" };
    }
  } catch {
    // Broken symlinks already caught by existsSync above
  }

  // Must be a directory
  const st = statSync(resolved);
  if (!st.isDirectory()) {
    return { error: `${resolved} is not a directory` };
  }

  return { path: resolved };
}

/**
 * Quick version that throws on failure. Use for early bail.
 */
export function requireProjectDir(raw: unknown): string {
  const result = validateProjectDir(raw);
  if (result.error) {
    throw new Error(`Invalid projectDir: ${result.error}`);
  }
  return result.path!;
}
