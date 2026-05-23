import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { MAX_EVENT_LOG_SIZE } from "../config/defaults.js";
import { SteleEvent } from "./types.js";

const MAX_FILE_SIZE = MAX_EVENT_LOG_SIZE;
const MAX_ROTATIONS = 5;

/**
 * Patterns for secret redaction in event payloads.
 * Uses word boundaries to avoid false positives on compound keys.
 */
const SECRET_PATTERNS =
  /\b(?:password|token|secret|api_key|apikey|authorization)\b/i;

/**
 * Recursively redact secrets in nested structures.
 */
function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  return redactPayload(value as Record<string, unknown>);
}

/**
 * Redact potential secrets in event payload values.
 */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_PATTERNS.test(key)) {
      result[key] = "<redacted>";
    } else {
      result[key] = redactValue(value);
    }
  }
  return result;
}

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
 * Append a single event line to a date-partitioned JSONL file.
 *
 * Returns early (no-op) if a symlink is detected on the events directory
 * or the target file. Write failures are swallowed by default.
 */
async function appendEventLine(
  projectRoot: string,
  event: SteleEvent,
): Promise<void> {
  const eventsDir = join(projectRoot, ".stele", "events");

  // Symlink detection: refuse to write through symlinks
  if (await isSymlink(eventsDir)) {
    return;
  }

  const filePath = getDateFilePath(projectRoot, event.timestamp);

  // Symlink detection on individual file
  if (await isSymlink(filePath)) {
    return;
  }

  // Rotate if file exceeds size limit
  const currentSize = await getFileSize(filePath);
  if (currentSize >= MAX_FILE_SIZE) {
    await rotateFile(filePath);
  }

  // Ensure the events directory exists
  await mkdir(eventsDir, { recursive: true });

  const redactedEvent = { ...event, payload: redactPayload(event.payload) };
  const line = JSON.stringify(redactedEvent) + "\n";

  // Append a single line (not atomic for large payloads; acceptable for
  // telemetry where small loss is tolerated).
  await appendFile(filePath, line);
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
    await appendEventLine(projectRoot, event);
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
  await appendEventLine(projectRoot, event);
}
