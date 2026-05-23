import path from "node:path";

/**
 * Cross-platform path.dirname wrapper.
 */
export function pathDirname(filePath: string): string {
  return path.dirname(filePath);
}

/**
 * Cross-platform path.resolve wrapper.
 */
export function pathResolve(...segments: string[]): string {
  return path.resolve(...segments);
}

/**
 * The platform-specific path separator.
 */
export const pathSep = path.sep;

/**
 * Check if a candidate path is within a directory.
 * Case-insensitive on Windows to match filesystem behavior.
 */
export function isPathWithin(candidate: string, directory: string): boolean {
  if (candidate === directory) {
    return true;
  }
  if (process.platform === "win32") {
    const c = candidate.toLowerCase();
    const d = directory.toLowerCase();
    return c.startsWith(d + path.sep);
  }
  return candidate.startsWith(directory + path.sep);
}
