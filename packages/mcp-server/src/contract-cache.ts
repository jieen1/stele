import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectState } from "./types.js";

const CONTRACT_DIR = "contract";
const CONFIG_FILE = "stele.config.json";

/**
 * Invalidate all watchers (no-op: watchers were removed in favor of TTL-based caching).
 * Kept for backward compatibility.
 */
export function clearWatchers(): void {
  // No-op: watcher infrastructure removed
}

/**
 * Cache of project states keyed by projectDir.
 */
const projectCache = new Map<string, ProjectState>();

/**
 * Get cached project state, or null if not cached.
 */
export function getCachedState(projectDir: string): ProjectState | null {
  const resolved = resolve(projectDir);
  return projectCache.get(resolved) ?? null;
}

/**
 * Set cached project state.
 */
export function setCachedState(state: ProjectState): void {
  projectCache.set(resolve(state.projectDir), state);
}

/**
 * Invalidate cached state for a project.
 */
export function invalidateCache(projectDir: string): void {
  projectCache.delete(resolve(projectDir));
}

/**
 * Scan for .stele contract files in a directory.
 */
export function scanSteleFiles(directory: string): string[] {
  const results: string[] = [];

  try {
    const entries = readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        results.push(...scanSteleFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".stele")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return results;
}

/**
 * Load all .stele contract files from the contract directory.
 * Returns basic file metadata without parsing.
 */
export function listContractFiles(contractDir: string): Array<{
  path: string;
  size: number;
  modified: string;
}> {
  const files = scanSteleFiles(contractDir);
  const results: Array<{
    path: string;
    size: number;
    modified: string;
  }> = [];

  for (const filePath of files) {
    try {
      const stats = statSync(filePath);
      results.push({
        path: filePath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
      });
    } catch {
      // Skip files that can't be read
    }
  }

  return results;
}

/**
 * Load project state from disk.
 * Caches the result for subsequent calls.
 */
export async function loadProjectState(projectDir: string): Promise<ProjectState> {
  const resolved = resolve(projectDir);
  const cached = projectCache.get(resolved);

  // Return cached state if valid (< 30s old)
  if (cached && Date.now() - cached.lastLoadTime < 30_000) {
    return cached;
  }

  const configPath = join(resolved, CONFIG_FILE);
  const contractDir = join(resolved, CONTRACT_DIR);
  let contractFiles: string[] = [];

  if (existsSync(contractDir)) {
    contractFiles = scanSteleFiles(contractDir);
  }

  const state: ProjectState = {
    projectDir: resolved,
    configPath,
    contractFiles,
    lastLoadTime: Date.now(),
  };

  projectCache.set(resolved, state);
  return state;
}

/**
 * Load contract file contents from the contract directory.
 */
export function loadContractFiles(contractDir: string): Array<{
  path: string;
  content: string;
}> {
  const files = scanSteleFiles(contractDir);
  const results: Array<{ path: string; content: string }> = [];

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf8");
      results.push({ path: filePath, content });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

/**
 * Check if a project has Stele configured.
 */
export function isSteleProject(projectDir: string): boolean {
  const contractDir = join(projectDir, CONTRACT_DIR);
  const configFile = join(projectDir, CONFIG_FILE);

  return existsSync(contractDir) && existsSync(configFile);
}

/**
 * Get the default protected patterns from config.
 */
export function getProtectedPatterns(projectDir: string): string[] {
  const configFile = join(projectDir, CONFIG_FILE);

  if (!existsSync(configFile)) {
    return [
      "contract/**/*.stele",
      "contract/checker_impls/**/*",
      "contract/.manifest.json",
      "tests/contract/**/*",
    ];
  }

  try {
    const raw = readFileSync(configFile, "utf8");
    const config = JSON.parse(raw);

    if (config?.protected && Array.isArray(config.protected)) {
      return config.protected;
    }
  } catch {
    // Ignore parse errors
  }

  return [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    "contract/.manifest.json",
    "tests/contract/**/*",
  ];
}

/**
 * Watch contract directory for changes and invalidate cache.
 * Deprecated: removed in favor of TTL-based caching. This function is a no-op.
 * Kept for backward compatibility.
 */
export function watchContractDir(_contractDir: string, _projectDir: string): void {
  // No-op: watcher infrastructure removed
}
