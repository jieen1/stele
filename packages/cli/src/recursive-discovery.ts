import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * Directory names that are unconditionally skipped when scanning for
 * `stele.config.json` files. These are typical build/cache locations that
 * never contain user-managed Stele projects, even though they may contain
 * `stele.config.json` files (e.g. inside `node_modules/some-package`).
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  ".pnpm-store",
  ".npm",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
]);

/**
 * Walk the filesystem rooted at `rootDir` and return a deterministic, lex-sorted
 * list of project directories. Each project directory contains a `stele.config.json`
 * file directly. Once a directory has `stele.config.json`, we do NOT descend into
 * it further: nested projects are not allowed by `--recursive`.
 *
 * The walk skips ignored directories (.git, node_modules, etc.) and other
 * dot-prefixed directories.
 */
export async function discoverProjects(rootDir: string): Promise<string[]> {
  const projects: string[] = [];
  await walk(rootDir, projects);
  return projects.sort();
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];

  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    // Unreadable directory (permissions, transient I/O) — skip silently to keep
    // discovery resilient on user systems with quirky directory trees.
    return;
  }

  if (entries.some((entry) => entry.isFile() && entry.name === "stele.config.json")) {
    out.push(dir);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue;
    }

    await walk(join(dir, entry.name), out);
  }
}
