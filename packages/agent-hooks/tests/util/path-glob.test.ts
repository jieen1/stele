import { describe, expect, it } from "vitest";
import { matchProtectedPath, isSafeGlobPattern } from "../../src/util/path-glob.js";

const PROJECT_ROOT = "/project";
const DEFAULT_PATTERNS = [
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "tests/contract/**/*",
];

describe("matchProtectedPath", () => {
  describe("basic matching", () => {
    it("matches contract file with absolute path", () => {
      expect(matchProtectedPath("/project/contract/main.stele", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("matches contract file with relative path", () => {
      expect(matchProtectedPath("contract/main.stele", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("matches nested contract file", () => {
      expect(matchProtectedPath("/project/contract/subdir/child.stele", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("does not match non-contract files", () => {
      expect(matchProtectedPath("/project/src/index.ts", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });

    it("does not match contract directory siblings", () => {
      expect(matchProtectedPath("/project/contract/notes.txt", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });
  });

  describe("checker_impls matching", () => {
    it("matches checker implementation file", () => {
      expect(matchProtectedPath("/project/contract/checker_impls/email_checker.py", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("matches nested checker implementation", () => {
      expect(matchProtectedPath("/project/contract/checker_impls/sub/deep.py", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });
  });

  describe("manifest and baseline matching", () => {
    it("matches .manifest.json", () => {
      expect(matchProtectedPath("/project/contract/.manifest.json", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("matches .baseline.json", () => {
      expect(matchProtectedPath("/project/contract/.baseline.json", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });
  });

  describe("tests/contract matching", () => {
    it("matches generated test file", () => {
      expect(matchProtectedPath("/project/tests/contract/test_email.py", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("matches nested generated test", () => {
      expect(matchProtectedPath("/project/tests/contract/subdir/test_email.py", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("does not match regular test files", () => {
      expect(matchProtectedPath("/project/tests/test_email.py", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("rejects empty path", () => {
      expect(matchProtectedPath("", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });

    it("handles path with trailing slash", () => {
      // Trailing slash makes it match as a file path (path resolution normalizes)
      expect(matchProtectedPath("/project/contract/main.stele/", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("handles contract directory itself (subtree-protected root)", () => {
      // The pattern contract/**/*.stele should NOT match the directory itself
      expect(matchProtectedPath("/project/contract", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });
  });

  describe("Python cache ignore", () => {
    it("ignores .pyc files even under protected dirs", () => {
      expect(matchProtectedPath("/project/contract/checker_impls/compiled.pyc", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });

    it("ignores .pyo files even under protected dirs", () => {
      expect(matchProtectedPath("/project/contract/checker_impls/compiled.pyo", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });

    it("does not ignore .py files under protected dirs", () => {
      expect(matchProtectedPath("/project/contract/checker_impls/compiled.py", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });
  });

  describe("custom patterns", () => {
    it("matches custom pattern", () => {
      expect(matchProtectedPath("/project/secrets/key.pem", ["secrets/**/*"], PROJECT_ROOT)).toBe(true);
    });

    it("does not match with empty patterns", () => {
      expect(matchProtectedPath("/project/anything/file.txt", [], PROJECT_ROOT)).toBe(false);
    });
  });

  describe("path normalization", () => {
    it("handles paths with double slashes", () => {
      expect(matchProtectedPath("/project//contract//main.stele", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });

    it("handles paths with dot segments", () => {
      expect(matchProtectedPath("/project/src/../contract/main.stele", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(true);
    });
  });

  describe("outside project", () => {
    it("does not match paths outside project", () => {
      expect(matchProtectedPath("/other/contract/main.stele", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });

    it("handles path traversal to outside", () => {
      expect(matchProtectedPath("/project/../other/contract/main.stele", DEFAULT_PATTERNS, PROJECT_ROOT)).toBe(false);
    });
  });

  describe("wildcard patterns", () => {
    it("matches single wildcard pattern", () => {
      expect(matchProtectedPath("/project/src/config.json", ["src/*.json"], PROJECT_ROOT)).toBe(true);
    });

    it("does not match when wildcard doesn't match depth", () => {
      expect(matchProtectedPath("/project/src/sub/config.json", ["src/*.json"], PROJECT_ROOT)).toBe(false);
    });

    it("matches recursive wildcard pattern", () => {
      expect(matchProtectedPath("/project/src/sub/config.json", ["src/**/*.json"], PROJECT_ROOT)).toBe(true);
    });
  });
});

describe("isSafeGlobPattern", () => {
  it("accepts normal glob patterns", () => {
    expect(isSafeGlobPattern("src/**/*.py")).toBe(true);
    expect(isSafeGlobPattern("contract/**/*")).toBe(true);
    expect(isSafeGlobPattern("src/*.js")).toBe(true);
  });

  it("rejects excessively long patterns", () => {
    expect(isSafeGlobPattern("a".repeat(4097))).toBe(false);
  });

  it("accepts patterns at max length", () => {
    expect(isSafeGlobPattern("a".repeat(4096))).toBe(true);
  });

  it("rejects deeply nested bracket patterns", () => {
    expect(isSafeGlobPattern("[a-[b-[c-[d-[e-[f]]]]]")).toBe(false);
  });

  it("accepts bracket patterns within depth limit", () => {
    expect(isSafeGlobPattern("[a-[b-[c-[d-[e]]]]]")).toBe(true);
  });

  it("accepts single bracket pattern", () => {
    expect(isSafeGlobPattern("[abc]")).toBe(true);
  });

  it("rejects unbalanced bracket patterns exceeding depth", () => {
    expect(isSafeGlobPattern("[[[[[[")).toBe(false);
  });

  it("handles empty pattern", () => {
    expect(isSafeGlobPattern("")).toBe(true);
  });

  it("matches normal pattern with safe glob", () => {
    expect(matchProtectedPath("/project/src/test.py", ["src/**/*.py"], PROJECT_ROOT)).toBe(true);
  });

  it("rejects unsafe pattern in matchProtectedPath", () => {
    // Pattern with excessive bracket nesting should silently fail to match
    const longPattern = "src/[a-[b-[c-[d-[e-[f]]]]].py";
    expect(matchProtectedPath("/project/src/test.py", [longPattern], PROJECT_ROOT)).toBe(false);
  });

  it("rejects very long pattern in matchProtectedPath", () => {
    const longPattern = "src/" + "a".repeat(4097);
    expect(matchProtectedPath("/project/src/test.py", [longPattern], PROJECT_ROOT)).toBe(false);
  });
});
