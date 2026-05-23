// Shared helpers used by multiple render-stele submodules.
// Pure string transforms — no IO, no state.

export function escapeString(s: string): string {
  // CDL uses double-quoted strings. Escape internal double quotes and backslashes.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
  * Normalize a layer value (string or string[]) into an array of glob paths.
  */
export function normalizeLayer(layer: string | string[]): string[] {
  const paths = typeof layer === "string" ? [layer] : layer;
  return paths.map((p) => ensureGlobSuffix(p));
}

/**
 * Ensure a path ends with a glob suffix (`/**`) so that `minimatch` matches
 * files inside the directory, not just the directory itself.
 *
 * Single-file paths (e.g., "server.ts", "model.py") are left as-is — they
 * already identify exactly one file and should not be turned into directory
 * globs like "server.ts/**".
 */
export function ensureGlobSuffix(path: string): string {
  if (path.endsWith("/**") || path.includes("/**/*.ts") || path.includes("/**/*.js")) {
    return path;
  }
  // Single-file path — do not append glob suffix
  if (path.match(/\.(ts|tsx|js|jsx|py|go|rs|java|kt|scala)$/)) {
    return path;
  }
  // Plain directory path like "packages/backend-typescript/src" — needs glob suffix
  if (!path.includes("**") && !path.includes("*")) {
    return `${path}/**`;
  }
  return path;
}

export function layerModuleId(contextId: string, layerName: string): string {
  return `${contextId}-${layerName}`;
}

export function aclModuleId(fromContext: string, toContext: string): string {
  return `${fromContext}-${toContext}-acl`;
}
