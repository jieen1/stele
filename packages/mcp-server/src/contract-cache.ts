import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectState } from "./types.js";

const CONTRACT_DIR = "contract";
const CONFIG_FILE = "stele.config.json";

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
 * Parse Stele contract content into invariants and checkers.
 * Uses regex extraction — not a full CDL parser.
 */
export function parseContract(content: string): ParsedContract {
  const invariants: ParsedInvariant[] = [];
  const checkers: ParsedChecker[] = [];

  const invariantRegex = /\(invariant\s+([A-Z_]+)\s*\n?([\s\S]*?)\)/g;
  let match: RegExpExecArray | null;

  while ((match = invariantRegex.exec(content))) {
    const id = match[1];
    const body = match[2] ?? "";
    const severityMatch = /\(severity\s+(error|warning|info)\)/.exec(body);
    const descMatch = /\(description\s+"([^"]*)"/.exec(body);

    invariants.push({
      id,
      severity: severityMatch?.[1] ?? "error",
      description: descMatch?.[1] ?? "",
    });
  }

  const checkerRegex = /\(checker\s+([a-zA-Z0-9_-]+)\s*\n?([\s\S]*?)\)/g;
  while ((match = checkerRegex.exec(content))) {
    const id = match[1];
    const body = match[2] ?? "";
    const descMatch = /\(description\s+"([^"]*)"/.exec(body);

    checkers.push({
      id,
      description: descMatch?.[1] ?? "",
    });
  }

  return { invariants, checkers };
}
