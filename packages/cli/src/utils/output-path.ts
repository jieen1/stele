import { join, relative, resolve } from "node:path";
import { ConfigError } from "../errors.js";

/**
 * Validate that an output file path stays within the project directory.
 * Prevents directory traversal attacks on report file output.
 *
 * Uses `relative()` to correctly handle Windows paths (backslashes,
 * case-insensitive drive letters) and symlink traversal.
 */
export function validateOutputPath(projectDir: string, outputPath: string): string {
  const resolved = resolve(projectDir, outputPath);
  const projectRes = resolve(projectDir);

  // Check with relative() — handles Windows drive letters and backslashes
  const rel = relative(projectRes, resolved);
  if (rel === "" || (rel && !rel.startsWith("..") && !rel.includes(join("..", "")))) {
    return resolved;
  }

  throw new ConfigError(
    `Output path "${outputPath}" resolves outside project directory (${projectRes}). ` +
    "Use a path relative to the project root."
  );
}
