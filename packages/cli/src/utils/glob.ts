import { readdirSync } from "node:fs";
import { minimatch } from "minimatch";
import { isAbsolute, relative, resolve } from "node:path";

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".stele"]);

export interface GlobOptions {
  projectDir: string;
}

/**
 * Expand a glob pattern to files within the project directory.
 *
 * Rejects patterns that escape the project root or contain directory traversal.
 * Ignores common ignored directories (node_modules, .git, dist, build, coverage, .stele).
 * Returns POSIX‐style relative paths, sorted lexicographically.
 */
export function safeGlob(pattern: string, options: GlobOptions): string[] {
  const normalized = pattern.replace(/\\/g, "/");

  // Reject absolute paths
  if (isAbsolute(normalized)) {
    throw new Error(`safeGlob: pattern must be relative, got "${normalized}"`);
  }

  // Reject directory traversal
  if (normalized.includes("..")) {
    throw new Error(`safeGlob: pattern must not contain "..", got "${normalized}"`);
  }

  const results = new Set<string>();
  const projectDir = resolve(options.projectDir);

  walkDirectory(projectDir, projectDir, normalized, results);

  return [...results].sort();
}

/**
 * Recursively walk `dir` matching files against `pattern`.
 */
function walkDirectory(dir: string, projectDir: string, pattern: string, results: Set<string>): void {
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;

  try {
    const raw = readdirSync(dir, { withFileTypes: true });
    entries = raw.map((d) => ({
      name: d.name,
      isFile: () => d.isFile(),
      isDirectory: () => d.isDirectory(),
    }));
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip ignored directories
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = resolve(dir, entry.name);
    const relPath = relative(projectDir, fullPath);
    // Normalize to POSIX paths for consistent matching across platforms
    const posixRel = relPath.replace(/\\/g, "/");

    if (entry.isDirectory()) {
      walkDirectory(fullPath, projectDir, pattern, results);
    } else if (entry.isFile()) {
      // Skip paths that escape the project root
      if (posixRel.startsWith("../")) {
        continue;
      }

      if (minimatch(posixRel, pattern)) {
        results.add(posixRel);
      }
    }
  }
}
