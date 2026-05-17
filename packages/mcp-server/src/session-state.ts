import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchProtectedPath } from "@stele/agent-hooks";
import type { Violation } from "@stele/core";
import type { CheckResult, SessionSummary, ValidateEditResult } from "./types.js";
import { getProtectedPatterns } from "./contract-cache.js";

const OBSERVATIONS_FILE = ".stele/agent/session-observations.jsonl";

/** Max number of edits to retain per session. */
const MAX_EDITS = 200;

/** Max number of check results to retain per session. */
const MAX_CHECKS = 50;

/** Max number of violations to retain per session. */
const MAX_VIOLATIONS = 100;

/**
 * Track session state for a single project.
 *
 * Records edits, check results, and violations encountered during
 * an MCP session. This enables "stele-check-session" to know what
 * changed since session start.
 */
export class SessionState {
  projectDir: string;
  edits: Array<{
    path: string;
    timestamp: number;
    wasProtected: boolean;
    result?: ValidateEditResult;
  }> = [];
  checks: Array<{
    timestamp: number;
    result: CheckResult;
  }> = [];
  violations: Map<string, Violation> = new Map();
  startTime: number;

  constructor(projectDir: string) {
    this.projectDir = resolve(projectDir);
    this.startTime = Date.now();
  }

  /**
   * Record an edit attempt.
   * Evicts oldest entries when over MAX_EDITS capacity.
   */
  recordEdit(targetPath: string, result: ValidateEditResult): void {
    const protectedPatterns = getProtectedPatterns(this.projectDir);
    const wasProtected = matchProtectedPath(targetPath, protectedPatterns, this.projectDir);

    this.edits.push({
      path: targetPath,
      timestamp: Date.now(),
      wasProtected,
      result,
    });

    if (this.edits.length > MAX_EDITS) {
      this.edits = this.edits.slice(-MAX_EDITS);
    }
  }

  /**
   * Record a check result.
   * Evicts oldest check results when over MAX_CHECKS capacity.
   */
  recordCheck(result: CheckResult): void {
    this.checks.push({
      timestamp: Date.now(),
      result,
    });

    if (this.checks.length > MAX_CHECKS) {
      this.checks = this.checks.slice(-MAX_CHECKS);
    }

    // Evict oldest violations when over capacity
    if (this.violations.size > MAX_VIOLATIONS) {
      const keys = Array.from(this.violations.keys());
      for (const key of keys.slice(0, keys.length - MAX_VIOLATIONS)) {
        this.violations.delete(key);
      }
    }
  }

  /**
   * Get the current session summary.
   */
  getSessionSummary(): SessionSummary {
    const protectedEdits = this.edits.filter((e) => e.wasProtected);
    const blockedEdits = protectedEdits.filter((e) => e.result?.allowed === false);

    return {
      totalEdits: this.edits.length,
      protectedEdits: protectedEdits.length,
      blockedEdits: blockedEdits.length,
      checks: this.checks.length,
      violations: this.violations.size,
      sessionDurationMs: Date.now() - this.startTime,
    };
  }

  /**
   * Get all violations encountered in the session.
   */
  getViolations(): Violation[] {
    return Array.from(this.violations.values());
  }

  /**
   * Get the last check result.
   */
  getLastCheck(): CheckResult | null {
    return this.checks.at(-1)?.result ?? null;
  }
}

/**
 * In-memory session registry keyed by projectDir.
 * Uses TTL-based cleanup to prevent memory leaks.
 */
const sessionRegistry = new Map<string, SessionState>();

/** Max number of sessions in registry. LRU eviction when exceeded. */
const MAX_SESSIONS = 100;

/** Interval for background cleanup of stale sessions. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Background cleanup timer reference (for cleanup scheduling). */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Sessions older than this (10 minutes) are cleaned up. */
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Clean up stale sessions from the registry.
 */
function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [key, session] of sessionRegistry) {
    if (now - session.startTime > SESSION_TTL_MS) {
      sessionRegistry.delete(key);
    }
  }
}

/**
 * Evict oldest sessions while registry exceeds max size.
 */
function evictIfOverCapacity(): void {
  while (sessionRegistry.size > MAX_SESSIONS) {
    // Find the oldest session and remove it
    let oldestKey: string | null = null;
    let oldestTime = Number.MAX_VALUE;

    for (const [key, session] of sessionRegistry) {
      if (session.startTime < oldestTime) {
        oldestKey = key;
        oldestTime = session.startTime;
      }
    }

    if (oldestKey) {
      sessionRegistry.delete(oldestKey);
    } else {
      break;
    }
  }
}

/**
 * Ensure the background cleanup timer is running.
 */
function ensureCleanupTimer(): void {
  if (cleanupTimer !== null) {
    return;
  }

  cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

/**
 * Get or create a session state for a project.
 * Cleans up stale sessions and evicts if over capacity on every access.
 */
export function getSessionState(projectDir: string): SessionState {
  cleanupStaleSessions();
  ensureCleanupTimer();

  const resolved = resolve(projectDir);
  let session = sessionRegistry.get(resolved);

  if (!session) {
    session = new SessionState(resolved);
    sessionRegistry.set(resolved, session);
    evictIfOverCapacity();
  }

  return session;
}

/**
 * Reset session state for a project.
 */
export function resetSession(projectDir: string): void {
  sessionRegistry.delete(resolve(projectDir));
}

/**
 * Destroy a specific session and release its references.
 * Call when a project directory is deleted or no longer relevant.
 */
export function destroySession(projectDir: string): void {
  sessionRegistry.delete(resolve(projectDir));
}

/**
 * Destroy all sessions whose project directories no longer exist.
 */
export function destroyStaleSessions(): void {
  for (const [key, session] of sessionRegistry) {
    if (!existsSync(session.projectDir)) {
      sessionRegistry.delete(key);
    }
  }
}

/**
 * Reset all sessions.
 */
export function resetAllSessions(): void {
  sessionRegistry.clear();
}

/**
 * Read material observations from the observation file.
 *
 * Returns the count of material observations that are relevant for
 * maintenance review decisions.
 */
/** Maximum file size for JSONL parsing (1 MB) */
const MAX_OBSERVATIONS_FILE_SIZE = 1 * 1024 * 1024;

/** Maximum line length for JSONL entries (64 KB) */
const MAX_LINE_LENGTH = 64 * 1024;

export function readMaterialObservations(projectDir: string): Array<Record<string, unknown>> {
  const resolvedDir = resolve(projectDir);
  const observationsFile = join(resolvedDir, OBSERVATIONS_FILE);

  try {
    // Size limit on file read
    const stats = statSync(observationsFile);
    if (stats.size > MAX_OBSERVATIONS_FILE_SIZE) {
      return [];
    }

    const content = readFileSync(observationsFile, "utf8");
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);

    const observations: Array<Record<string, unknown>> = [];

    for (const line of lines) {
      // Skip lines that exceed max length
      if (line.length > MAX_LINE_LENGTH) {
        continue;
      }

      try {
        const obs = JSON.parse(line);
        if (obs && typeof obs === "object") {
          observations.push(obs);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return observations.filter((obs) => obs.material_change === true);
  } catch {
    return [];
  }
}

/**
 * Check if a path matches any protected pattern.
 * Re-exported as isProtectedPath for backward compatibility.
 */
export { matchProtectedPath as isProtectedPath };
