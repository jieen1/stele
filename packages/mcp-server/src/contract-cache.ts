import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PROTECTED_PATTERNS, loadContract } from "@stele/core";
import type { ProjectState } from "./types.js";

const CONTRACT_DIR = "contract";
const CONFIG_FILE = "stele.config.json";

/**
 * Maximum number of cached project states.
 */
const MAX_CACHE_ENTRIES = 100;

/**
 * Cache of project states keyed by projectDir.
 */
const projectCache = new Map<string, ProjectState>();

/** Cache TTL in milliseconds. */
const CACHE_TTL_MS = 30_000;

/**
 * Evict entries that exceed TTL. Called on every cache access.
 */
function evictCache(): void {
  const now = Date.now();
  for (const [key, value] of projectCache) {
    if (now - value.lastLoadTime > CACHE_TTL_MS) {
      projectCache.delete(key);
    }
  }
  // Evict oldest entries if cache is too large
  if (projectCache.size > MAX_CACHE_ENTRIES) {
    const sorted = [...projectCache.entries()].sort((a, b) => a[1].lastLoadTime - b[1].lastLoadTime);
    for (let i = 0; i < sorted.length - MAX_CACHE_ENTRIES; i += 1) {
      projectCache.delete(sorted[i]![0]);
    }
  }
}

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

/** Maximum recursion depth for directory scanning. Prevents stack overflow on adversarially crafted directory structures. */
const MAX_SCAN_DEPTH = 10;

/**
 * Scan for .stele contract files in a directory.
 * Depth-limited to prevent stack overflow on adversarially crafted directory structures.
 */
export function scanSteleFiles(directory: string): string[] {
  return scanSteleFilesInternal(directory, 0);
}

function scanSteleFilesInternal(directory: string, depth: number): string[] {
  const results: string[] = [];

  try {
    if (depth > MAX_SCAN_DEPTH) {
      return results;
    }

    const entries = readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        results.push(...scanSteleFilesInternal(fullPath, depth + 1));
      } else if (entry.isFile() && entry.name.endsWith(".stele")) {
        results.push(fullPath);
      }
    }
  } catch {
    console.error("[stele] Failed to scan contract directory");
  }

  return results.sort();
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
  // Evict expired entries on every cache access
  evictCache();

  const resolved = resolve(projectDir);
  const cached = projectCache.get(resolved);

  // Return cached state if valid (< 30s old)
  if (cached && Date.now() - cached.lastLoadTime < CACHE_TTL_MS) {
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
    return [...DEFAULT_PROTECTED_PATTERNS];
  }

  try {
    const raw = readFileSync(configFile, "utf8");
    const config = JSON.parse(raw);

    if (config?.protected && Array.isArray(config.protected)) {
      return config.protected;
    }
  } catch (err) {
    console.error("[stele] Failed to parse project config");
  }

  return [...DEFAULT_PROTECTED_PATTERNS];
}

export interface ParsedInvariant {
  id: string;
  severity: string;
  description: string;
}

export interface ParsedChecker {
  id: string;
  description: string;
}

export interface ParsedContract {
  invariants: ParsedInvariant[];
  checkers: ParsedChecker[];
}

/**
 * Parse contract from a file path using @stele/core loadContract.
 * Uses the authoritative CDL parser — no regex divergence risk.
 */
export async function parseContractFromFile(filePath: string): Promise<ParsedContract> {
  try {
    const contract = await loadContract(resolve(filePath));
    const invariants: ParsedInvariant[] = [];
    for (const inv of contract.invariants) {
      // Use ?? to handle undefined fields safely (avoids unsafe `as string` cast)
      invariants.push({
        id: inv.id ?? "",
        severity: inv.severity ?? "",
        description: inv.description ?? "",
      } satisfies ParsedInvariant);
    }
    return { invariants, checkers: [] };
  } catch (err) {
    console.error("[stele] Failed to parse contract file");
    return { invariants: [], checkers: [] };
  }
}
