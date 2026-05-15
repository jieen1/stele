import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Violation } from "@stele/core";
import type { CheckResult, ValidateEditResult } from "./types.js";
import { getProtectedPatterns } from "./contract-cache.js";

const OBSERVATIONS_FILE = ".stele/agent/session-observations.jsonl";

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
   */
  recordEdit(path: string, result: ValidateEditResult): void {
    const protectedPatterns = getProtectedPatterns(this.projectDir);
    const wasProtected = isProtectedPath(path, protectedPatterns);

    this.edits.push({
      path,
      timestamp: Date.now(),
      wasProtected,
      result,
    });
  }

  /**
   * Record a check result.
   */
  recordCheck(result: CheckResult): void {
    this.checks.push({
      timestamp: Date.now(),
      result,
    });

    for (const violation of result.violations) {
      this.violations.set(violation.fingerprint, violation);
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
 * Session summary for status reporting.
 */
export interface SessionSummary {
  totalEdits: number;
  protectedEdits: number;
  blockedEdits: number;
  checks: number;
  violations: number;
  sessionDurationMs: number;
}

/**
 * In-memory session registry keyed by projectDir.
 */
const sessionRegistry = new Map<string, SessionState>();

/**
 * Get or create a session state for a project.
 */
export function getSessionState(projectDir: string): SessionState {
  const resolved = resolve(projectDir);
  let session = sessionRegistry.get(resolved);

  if (!session) {
    session = new SessionState(resolved);
    sessionRegistry.set(resolved, session);
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
export function readMaterialObservations(projectDir: string): Array<Record<string, unknown>> {
  const observationsFile = join(projectDir, OBSERVATIONS_FILE);

  if (!existsSync(observationsFile)) {
    return [];
  }

  try {
    const content = readFileSync(observationsFile, "utf8");
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);

    const observations: Array<Record<string, unknown>> = [];

    for (const line of lines) {
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
 *
 * This is a simplified glob matcher for the common cases.
 * For full glob support, use the path-glob utility from @stele/agent-hooks.
 */
export function isProtectedPath(filePath: string, patterns: string[]): boolean {
  // Simple prefix-based check for common patterns
  for (const pattern of patterns) {
    if (pattern.includes("**")) {
      const prefix = pattern.replace("**/*", "");
      if (filePath.startsWith(prefix) || filePath.includes(join(prefix, ""))) {
        return true;
      }
    } else if (filePath === pattern) {
      return true;
    }
  }

  return false;
}
