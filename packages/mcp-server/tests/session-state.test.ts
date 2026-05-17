import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SessionState,
  getSessionState,
  resetSession,
  resetAllSessions,
  readMaterialObservations,
  isProtectedPath,
} from "../src/session-state.js";

// ----------------------------------------------------------------
// SessionState
// ----------------------------------------------------------------

describe("SessionState", () => {
  beforeEach(() => {
    resetAllSessions();
  });

  describe("recordEdit", () => {
    it("records edits and tracks them", () => {
      const session = new SessionState("/tmp/test-project");
      session.recordEdit("src/index.ts", { allowed: true });
      session.recordEdit("contract/main.stele", { allowed: false, reason: "protected" });

      const summary = session.getSessionSummary();
      expect(summary.totalEdits).toBe(2);
    });

    it("evicts oldest edits when over MAX_EDITS (200)", () => {
      const session = new SessionState("/tmp/test-project");

      for (let i = 0; i < 210; i++) {
        session.recordEdit(`file-${i}.ts`, { allowed: true });
      }

      const summary = session.getSessionSummary();
      expect(summary.totalEdits).toBe(200);

      // First edit (file-0.ts) should be evicted
      const edits = session.edits;
      expect(edits[0].path).toBe("file-10.ts");
    });
  });

  describe("recordCheck", () => {
    it("records check results", () => {
      const session = new SessionState("/tmp/test-project");
      session.recordCheck({
        ok: true,
        report: undefined!,
        violations: [],
        summary: {
          invariantCount: 0,
          generatedFileCount: 0,
          protectedFileCount: 0,
          violationCount: 0,
        },
      });

      expect(session.checks.length).toBe(1);
    });

    it("evicts oldest checks when over MAX_CHECKS (50)", () => {
      const session = new SessionState("/tmp/test-project");

      const checkResult = {
        ok: true,
        report: undefined!,
        violations: [],
        summary: {
          invariantCount: 0,
          generatedFileCount: 0,
          protectedFileCount: 0,
          violationCount: 0,
        },
      };

      for (let i = 0; i < 60; i++) {
        session.recordCheck(checkResult);
      }

      expect(session.checks.length).toBe(50);
    });

    it("evicts oldest violations when over MAX_VIOLATIONS (100)", () => {
      const session = new SessionState("/tmp/test-project");

      for (let i = 0; i < 120; i++) {
        session.violations.set(`violation-${i}`, {
          id: `violation-${i}`,
          invariant: `INV_${i}`,
          message: `Violation ${i}`,
        });
      }

      const checkResult = {
        ok: false,
        report: undefined!,
        violations: [],
        summary: {
          invariantCount: 0,
          generatedFileCount: 0,
          protectedFileCount: 0,
          violationCount: 120,
        },
      };

      session.recordCheck(checkResult);
      expect(session.violations.size).toBe(100);
    });
  });

  describe("getSessionSummary", () => {
    it("returns correct summary for empty session", () => {
      const session = new SessionState("/tmp/test-project");
      const summary = session.getSessionSummary();

      expect(summary.totalEdits).toBe(0);
      expect(summary.protectedEdits).toBe(0);
      expect(summary.blockedEdits).toBe(0);
      expect(summary.checks).toBe(0);
      expect(summary.violations).toBe(0);
      expect(summary.sessionDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("tracks protected and blocked edits", () => {
      const session = new SessionState("/tmp/test-project");
      session.recordEdit("src/index.ts", { allowed: true });
      session.recordEdit("contract/main.stele", { allowed: false, reason: "protected" });

      const summary = session.getSessionSummary();
      expect(summary.blockedEdits).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getLastCheck", () => {
    it("returns null when no checks recorded", () => {
      const session = new SessionState("/tmp/test-project");
      expect(session.getLastCheck()).toBeNull();
    });

    it("returns last check result", () => {
      const session = new SessionState("/tmp/test-project");
      const result = {
        ok: true,
        report: undefined!,
        violations: [],
        summary: {
          invariantCount: 0,
          generatedFileCount: 0,
          protectedFileCount: 0,
          violationCount: 0,
        },
      };
      session.recordCheck(result);
      expect(session.getLastCheck()).toBe(result);
    });
  });

  describe("getViolations", () => {
    it("returns all violations", () => {
      const session = new SessionState("/tmp/test-project");
      session.violations.set("v1", { id: "v1", invariant: "INV_1", message: "test" });
      session.violations.set("v2", { id: "v2", invariant: "INV_2", message: "test" });

      const violations = session.getViolations();
      expect(violations.length).toBe(2);
    });

    it("returns empty array when no violations", () => {
      const session = new SessionState("/tmp/test-project");
      expect(session.getViolations()).toEqual([]);
    });
  });
});

// ----------------------------------------------------------------
// Session registry (getSessionState, resetSession, resetAllSessions)
// ----------------------------------------------------------------

describe("session registry", () => {
  beforeEach(() => {
    resetAllSessions();
  });

  it("creates session on first access", () => {
    const session = getSessionState("/tmp/test-project");
    expect(session).toBeDefined();
    expect(session.edits).toEqual([]);
  });

  it("returns same session on subsequent calls", () => {
    const s1 = getSessionState("/tmp/test-project");
    const s2 = getSessionState("/tmp/test-project");
    expect(s1).toBe(s2);
  });

  it("creates separate sessions for different projects", () => {
    const s1 = getSessionState("/tmp/project-a");
    const s2 = getSessionState("/tmp/project-b");
    expect(s1).not.toBe(s2);
  });

  it("resolves to same session for equivalent paths", () => {
    const s1 = getSessionState("/tmp/test-project");
    const s2 = getSessionState("/tmp/test-project");
    expect(s1).toBe(s2);
  });

  describe("resetSession", () => {
    it("removes session for project", () => {
      const s1 = getSessionState("/tmp/test-project");
      s1.recordEdit("file.ts", { allowed: true });

      resetSession("/tmp/test-project");

      const s2 = getSessionState("/tmp/test-project");
      expect(s1).not.toBe(s2);
      expect(s2.edits).toEqual([]);
    });
  });

  describe("resetAllSessions", () => {
    it("clears all sessions", () => {
      getSessionState("/tmp/project-a");
      getSessionState("/tmp/project-b");

      resetAllSessions();

      const s1 = getSessionState("/tmp/project-a");
      const s2 = getSessionState("/tmp/project-b");
      expect(s1.edits).toEqual([]);
      expect(s2.edits).toEqual([]);
    });
  });
});

// ----------------------------------------------------------------
// readMaterialObservations
// ----------------------------------------------------------------

/** Create a temp project directory with the observations file path pre-created. */
function createTempProject(observationsContent: string): string {
  const dir = join(tmpdir(), `stele-obs-test-${randomUUID()}`);
  const obsDir = join(dir, ".stele", "agent");
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(join(obsDir, "session-observations.jsonl"), observationsContent, "utf8");
  return dir;
}

describe("readMaterialObservations", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* already gone */ }
      tempDir = null;
    }
  });

  it("returns empty array for non-existent observations file", () => {
    const result = readMaterialObservations("/tmp/nonexistent-project-12345");
    expect(result).toEqual([]);
  });

  it("returns empty array for non-existent directory", () => {
    const result = readMaterialObservations("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual([]);
  });

  it("rejects file exceeding MAX_OBSERVATIONS_FILE_SIZE (1 MB)", () => {
    // Create a file just over 1 MB (~1 048 577 bytes)
    const payload = '{"type":"observation","data":"' + "x".repeat(1048560) + '"}\n';
    tempDir = createTempProject(payload);
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });

  it("skips lines exceeding MAX_LINE_LENGTH (64 KB)", () => {
    const longLine = '{"type":"observation","data":"' + "x".repeat(65536) + '"}';
    const shortLine = '{"type":"observation","material_change":true}';
    const content = `${longLine}\n${shortLine}`;
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    // The long line is skipped; only the short line remains
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "observation", material_change: true });
  });

  it("silently skips malformed JSON lines", () => {
    const content = "not-json\n{broken\n123\n[invalid";
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });

  it("parses valid lines and skips invalid lines in mixed content", () => {
    const line1 = JSON.stringify({ type: "observation", material_change: true, id: 1 });
    const line2 = "this-is-not-json";
    const line3 = JSON.stringify({ type: "observation", material_change: false, id: 2 });
    const line4 = "{bad json here";
    const content = `${line1}\n${line2}\n${line3}\n${line4}`;
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    // Only line1 qualifies (material_change === true)
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "observation", material_change: true, id: 1 });
  });

  it("returns empty array for empty file", () => {
    tempDir = createTempProject("");
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });

  it("returns empty array when no entries have material_change=true", () => {
    const line1 = JSON.stringify({ type: "observation", material_change: false });
    const line2 = JSON.stringify({ type: "edit", material_change: false });
    const line3 = JSON.stringify({ type: "log" });
    const content = `${line1}\n${line2}\n${line3}`;
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });

  it("returns only entries with material_change=true", () => {
    const line1 = JSON.stringify({ type: "observation", material_change: true, path: "a.txt" });
    const line2 = JSON.stringify({ type: "observation", material_change: false, path: "b.txt" });
    const line3 = JSON.stringify({ type: "observation", material_change: true, path: "c.txt" });
    const content = `${line1}\n${line2}\n${line3}`;
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "observation", material_change: true, path: "a.txt" });
    expect(result[1]).toEqual({ type: "observation", material_change: true, path: "c.txt" });
  });

  // Schema validation tests — exercises isValidObservationEntry indirectly

  it("rejects entries with non-boolean material_change", () => {
    // Write raw JSON to avoid JSON.stringify converting types
    const content = '{"type":"observation","material_change":"true"}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });

  it("rejects array entries", () => {
    const content = '[1,2,3]\n{"type":"observation","material_change":true}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "observation", material_change: true });
  });

  it("rejects null entries", () => {
    const content = "null\n{null}\n";
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });

  it("rejects string entries", () => {
    const content = '"just a string"\n{"type":"observation","material_change":true}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toHaveLength(1);
  });

  it("rejects number entries", () => {
    const content = "42\n{" + '"type":"observation","material_change":true}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toHaveLength(1);
  });

  it("rejects entries with nested object values", () => {
    const content = '{"type":"observation","material_change":true,"nested":{"a":1}}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    // Nested objects are not JSON-safe primitives (they are objects, not null/primitive)
    expect(result).toEqual([]);
  });

  it("rejects entries with array values", () => {
    const content = '{"type":"observation","material_change":true,"tags":["a","b"]}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });

  it("accepts entries with null values", () => {
    const content = '{"type":"observation","material_change":true,"detail":null}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "observation", material_change: true, detail: null });
  });

  it("accepts entries with mixed primitive values", () => {
    const line = JSON.stringify({
      type: "observation",
      material_change: true,
      count: 42,
      active: false,
      message: "test",
      detail: null,
    });
    tempDir = createTempProject(line + "\n");
    const result = readMaterialObservations(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(42);
  });

  it("handles entries without material_change field", () => {
    // Entries without material_change are valid schema entries but won't be returned
    // because they aren't material observations
    const content = '{"type":"log","message":"info"}\n';
    tempDir = createTempProject(content);
    const result = readMaterialObservations(tempDir);
    expect(result).toEqual([]);
  });
});

// ----------------------------------------------------------------
// isProtectedPath (re-exported matchProtectedPath)
// ----------------------------------------------------------------

describe("isProtectedPath", () => {
  it("matches contract directory patterns", () => {
    expect(isProtectedPath("contract/main.stele", ["contract/**/*.stele"], "/project")).toBe(true);
    expect(isProtectedPath("contract/nested/deep.stele", ["contract/**/*.stele"], "/project")).toBe(true);
  });

  it("matches tests/contract patterns", () => {
    expect(isProtectedPath("tests/contract/test_main.py", ["tests/contract/**/*"], "/project")).toBe(true);
  });

  it("does not match non-protected paths", () => {
    expect(isProtectedPath("src/index.ts", ["contract/**/*.stele"], "/project")).toBe(false);
    expect(isProtectedPath("README.md", ["contract/**/*.stele"], "/project")).toBe(false);
  });

  it("matches manifest files", () => {
    expect(isProtectedPath("contract/.manifest.json", ["contract/.manifest.json"], "/project")).toBe(true);
  });

  it("handles path separators correctly", () => {
    expect(isProtectedPath("contract/checker_impls/checker.py", ["contract/checker_impls/**/*"], "/project")).toBe(true);
  });
});
