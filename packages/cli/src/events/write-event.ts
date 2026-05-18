import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { SteleEvent } from "./types.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATIONS = 5;
const FILE_MODE = 0o644;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRotatedFile(basePath: string, rotation: number): string {
  return basePath.replace(/\.jsonl$/, `.${rotation}.jsonl`);
}

function getDateFilePath(
  projectRoot: string,
  timestamp: string,
): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dateStr = `${year}-${month}-${day}`;
  return join(projectRoot, ".stele", "events", `${dateStr}.jsonl`);
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function getFileSize(path: string): Promise<number> {
  try {
    const stats = await stat(path);
    return stats.size;
  } catch {
    return 0;
  }
}

async function rotateFile(basePath: string): Promise<void> {
  const oldest = getRotatedFile(basePath, MAX_ROTATIONS);
  try {
    await rm(oldest, { force: true });
  } catch {
    // Already gone
  }

  for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
    const src = getRotatedFile(basePath, i);
    const dst = getRotatedFile(basePath, i + 1);
    try {
      await rename(src, dst);
    } catch {
      // Source may not exist, that's fine
    }
  }

  const firstRotated = getRotatedFile(basePath, 1);
  try {
    await rename(basePath, firstRotated);
  } catch {
    // File may not exist yet, that's fine
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new event with auto-generated id and timestamp.
 */
export function createEvent(
  type: SteleEvent["type"],
  projectRoot: string,
  payload: Record<string, unknown>,
  options?: {
    session_id?: string;
    git_commit?: string;
    git_branch?: string;
  },
): SteleEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    version: "1",
    project_root: projectRoot,
    git_commit: options?.git_commit,
    git_branch: options?.git_branch,
    payload,
    session_id: options?.session_id ?? "",
  };
}

/**
 * Append a structured event to a JSONL file.
 * Write failures are caught and silently swallowed (do not break the caller).
 */
export async function writeEvent(
  projectRoot: string,
  event: SteleEvent,
): Promise<void> {
  try {
    const eventsDir = join(projectRoot, ".stele", "events");

    // Symlink detection: refuse to write through symlinks
    if (await isSymlink(eventsDir)) {
      return;
    }

    const filePath = getDateFilePath(projectRoot, event.timestamp);

    // Check if we need to rotate
    const currentSize = await getFileSize(filePath);
    if (currentSize >= MAX_FILE_SIZE) {
      await rotateFile(filePath);
    }

    // Ensure the events directory exists
    await mkdir(eventsDir, { recursive: true });

    const line = JSON.stringify(event) + "\n";

    // Atomic append: read existing content (if any), append, write to temp, rename
    const tmpPath = `${filePath}.tmp`;
    let existing = "";
    try {
      existing = await readFile(filePath, "utf8");
    } catch {
      // File does not exist yet
    }

    await writeFile(tmpPath, existing + line, { mode: FILE_MODE });
    await rename(tmpPath, filePath);
    await chmod(filePath, FILE_MODE);
  } catch {
    // Write failures must not break the calling operation
  }
}

/**
 * For testing only: write event but throw errors instead of swallowing them.
 */
export async function writeEventStrict(
  projectRoot: string,
  event: SteleEvent,
): Promise<void> {
  const eventsDir = join(projectRoot, ".stele", "events");

  // Symlink detection: refuse to write through symlinks
  if (await isSymlink(eventsDir)) {
    return;
  }

  const filePath = getDateFilePath(projectRoot, event.timestamp);

  // Check if we need to rotate
  const currentSize = await getFileSize(filePath);
  if (currentSize >= MAX_FILE_SIZE) {
    await rotateFile(filePath);
  }

  // Ensure the events directory exists
  await mkdir(eventsDir, { recursive: true });

  const line = JSON.stringify(event) + "\n";

  // Atomic append: read existing content (if any), append, write to temp, rename
  const tmpPath = `${filePath}.tmp`;
  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    // File does not exist yet
  }

  await writeFile(tmpPath, existing + line, { mode: FILE_MODE });
  await rename(tmpPath, filePath);
  await chmod(filePath, FILE_MODE);
}
