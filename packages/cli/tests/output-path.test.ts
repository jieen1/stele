import { describe, expect, it } from "vitest";
import { validateOutputPath } from "../src/utils/output-path.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("validateOutputPath", () => {
  let projectDir: string;

  it("accepts paths within project directory", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "stele-output-test-"));
    try {
      expect(validateOutputPath(projectDir, "docs/report.md")).toContain(resolve(projectDir));
      expect(validateOutputPath(projectDir, ".stele/summary.md")).toContain(resolve(projectDir));
      expect(validateOutputPath(projectDir, "output/nested/file.txt")).toContain(resolve(projectDir));
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal with ../", () => {
    expect(() => validateOutputPath("/project", "../outside.md")).toThrow("resolves outside");
  });

  it("rejects path traversal with deeply nested ../", () => {
    expect(() => validateOutputPath("/project", "foo/../../outside.md")).toThrow("resolves outside");
  });

  it("rejects absolute paths outside project", () => {
    expect(() => validateOutputPath("/project", "/tmp/outside.md")).toThrow("resolves outside");
  });

  it("rejects paths resolving to parent directory", () => {
    expect(() => validateOutputPath("/project/subdir", "../secret.md")).toThrow("resolves outside");
  });

  it("accepts paths with internal normalization", async () => {
    projectDir = await mkdtemp(join(tmpdir(), "stele-output-test-"));
    try {
      // foo/../bar should normalize to bar, which is inside project
      expect(validateOutputPath(projectDir, "foo/../bar.md")).toContain(resolve(projectDir));
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("accepts relative paths", () => {
    expect(() => validateOutputPath("/project", "report.md")).not.toThrow();
  });

  it("error message includes paths", () => {
    try {
      validateOutputPath("/myproject", "../outside.md");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("../outside.md");
      expect(msg).toContain("myproject");
    }
  });
});
