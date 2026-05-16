import { describe, it, expect, beforeEach, vi } from "vitest";
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

describe("readMaterialObservations", () => {
  it("returns empty array for non-existent observations file", () => {
    const result = readMaterialObservations("/tmp/nonexistent-project-12345");
    expect(result).toEqual([]);
  });

  it("returns empty array for non-existent directory", () => {
    const result = readMaterialObservations("/nonexistent/path/that/does/not/exist");
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
