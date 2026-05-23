import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareInvariants,
  toProjectRelativePath,
  readOptionalFile,
  ensureDirectory,
  writeIfMissing,
  escapeTsvCell,
  isMissingFileError,
} from "../src/utils/shared-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-cli-utils-"));
  tempDirs.push(directory);
  return directory;
}

// ---------------------------------------------------------------------------
// compareInvariants sorting
// ---------------------------------------------------------------------------
describe("compareInvariants", () => {
  function inv(filePath: string, line: number, column: number, id: string) {
    return { filePath, span: { line, column }, id };
  }

  it("sorts by file path first", () => {
    const a = inv("b.stele", 1, 1, "rule-a");
    const b = inv("a.stele", 100, 1, "rule-b");

    expect(compareInvariants(a, b)).toBeGreaterThan(0);
    expect(compareInvariants(b, a)).toBeLessThan(0);
  });

  it("sorts by line number when file paths match", () => {
    const a = inv("x.stele", 10, 1, "rule-a");
    const b = inv("x.stele", 2, 1, "rule-b");

    expect(compareInvariants(a, b)).toBeGreaterThan(0);
    expect(compareInvariants(b, a)).toBeLessThan(0);
  });

  it("sorts by column number when file and line match", () => {
    const a = inv("x.stele", 5, 20, "rule-a");
    const b = inv("x.stele", 5, 3, "rule-b");

    expect(compareInvariants(a, b)).toBeGreaterThan(0);
    expect(compareInvariants(b, a)).toBeLessThan(0);
  });

  it("sorts by invariant id when all span fields match", () => {
    const a = inv("x.stele", 1, 1, "zzz");
    const b = inv("x.stele", 1, 1, "aaa");

    expect(compareInvariants(a, b)).toBeGreaterThan(0);
    expect(compareInvariants(b, a)).toBeLessThan(0);
  });

  it("returns 0 for identical invariants", () => {
    const a = inv("x.stele", 1, 1, "rule");
    expect(compareInvariants(a, a)).toBe(0);
  });

  it("supports stable array sorting", () => {
    const items = [
      inv("b.stele", 2, 1, "r3"),
      inv("a.stele", 3, 1, "r2"),
      inv("a.stele", 1, 1, "r4"),
      inv("a.stele", 1, 2, "r1"),
    ];

    const sorted = [...items].sort(compareInvariants);
    // Expected sort order: file path, then line, then column, then id
    // a.stele:1:1 r4, a.stele:1:2 r1, a.stele:3:1 r2, b.stele:2:1 r3
    expect(sorted[0].id).toBe("r4");
    expect(sorted[0].span.line).toBe(1);
    expect(sorted[0].span.column).toBe(1);
    expect(sorted[1].id).toBe("r1");
    expect(sorted[1].span.line).toBe(1);
    expect(sorted[1].span.column).toBe(2);
    expect(sorted[2].id).toBe("r2");
    expect(sorted[2].span.line).toBe(3);
    expect(sorted[3].id).toBe("r3");
    expect(sorted[3].filePath).toBe("b.stele");
  });
});

// ---------------------------------------------------------------------------
// toProjectRelativePath
// ---------------------------------------------------------------------------
describe("toProjectRelativePath", () => {
  it("converts absolute path to relative path", () => {
    const result = toProjectRelativePath("/home/user/project", "/home/user/project/src/file.stele");
    expect(result).toBe("src/file.stele");
  });

  // Round 4 F-D-02: the path resolver behaves differently per platform
  // (path.relative on Linux treats `C:\Users\project` as a literal name);
  // pin this test to Windows so it doesn't false-fail on Linux dev machines
  // / CI runners. CI runs the same suite on the matrix's Windows leg.
  (process.platform === "win32" ? it : it.skip)(
    "normalizes backslashes on Windows-style paths",
    () => {
      const result = toProjectRelativePath("C:\\Users\\project", "C:\\Users\\project\\src\\file.stele");
      expect(result).toBe("src/file.stele");
    },
  );

  it("handles paths outside the project directory", () => {
    const result = toProjectRelativePath("/home/user/project", "/home/user/other/file.stele");
    expect(result).toBe("../other/file.stele");
  });

  it("returns just the filename for files in the project root", () => {
    const result = toProjectRelativePath("/home/user/project", "/home/user/project/main.stele");
    expect(result).toBe("main.stele");
  });
});

// ---------------------------------------------------------------------------
// readOptionalFile
// ---------------------------------------------------------------------------
describe("readOptionalFile", () => {
  it("returns file content for existing files", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "test.txt");
    await writeFile(filePath, "hello world", "utf8");

    const content = await readOptionalFile(filePath);
    expect(content).toBe("hello world");
  });

  it("returns undefined for non-existent files", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "does-not-exist.txt");

    const content = await readOptionalFile(filePath);
    expect(content).toBeUndefined();
  });

  it("re-throws non-ENOENT errors", async () => {
    const dir = await createTempDir();
    // A directory exists, so trying to readFile on it should throw non-ENOENT
    await expect(readOptionalFile(dir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ensureDirectory
// ---------------------------------------------------------------------------
describe("ensureDirectory", () => {
  it("creates nested directories recursively", async () => {
    const dir = await createTempDir();
    const target = join(dir, "a", "b", "c", "file.txt");

    await ensureDirectory(target);

    // Verify the directory was created by writing a file
    await writeFile(target, "test", "utf8");
    const content = await readFile(target, "utf8");
    expect(content).toBe("test");
  });

  it("does not fail when directory already exists", async () => {
    const dir = await createTempDir();
    const target = join(dir, "exists", "file.txt");

    await ensureDirectory(target);
    await ensureDirectory(target);

    // Should not throw
    expect(() => {}).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeIfMissing
// ---------------------------------------------------------------------------
describe("writeIfMissing", () => {
  it("writes content when file does not exist", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "new.txt");

    await writeIfMissing(filePath, "fresh content");
    const content = await readFile(filePath, "utf8");
    expect(content).toBe("fresh content");
  });

  it("does not overwrite existing files", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "existing.txt");

    await writeFile(filePath, "original content", "utf8");
    await writeIfMissing(filePath, "new content");

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("original content");
  });

  it("creates parent directories before writing", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "nested", "deep", "file.txt");

    await writeIfMissing(filePath, "content");
    const content = await readFile(filePath, "utf8");
    expect(content).toBe("content");
  });

  it("handles race condition gracefully (EEXIST)", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "race.txt");

    // Both calls race to create the same file; only one should succeed.
    await Promise.all([
      writeIfMissing(filePath, "content-a"),
      writeIfMissing(filePath, "content-b"),
    ]);

    const content = await readFile(filePath, "utf8");
    expect(["content-a", "content-b"]).toContain(content);
  });
});

// ---------------------------------------------------------------------------
// escapeTsvCell
// ---------------------------------------------------------------------------
describe("escapeTsvCell", () => {
  it("leaves plain strings unchanged", () => {
    expect(escapeTsvCell("hello world")).toBe("hello world");
  });

  it("escapes tab characters", () => {
    expect(escapeTsvCell("hello\tworld")).toBe("hello\\tworld");
  });

  it("escapes newline characters", () => {
    expect(escapeTsvCell("hello\nworld")).toBe("hello\\nworld");
  });

  it("escapes carriage return characters", () => {
    expect(escapeTsvCell("hello\rworld")).toBe("hello\\rworld");
  });

  it("escapes backslash characters", () => {
    expect(escapeTsvCell("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("escapes multiple special characters in sequence", () => {
    expect(escapeTsvCell("a\tb\nc\rdd")).toBe("a\\tb\\nc\\rdd");
  });

  it("handles backslash followed by special characters", () => {
    expect(escapeTsvCell("C:\\new\tab")).toBe("C:\\\\new\\tab");
  });

  it("handles empty strings", () => {
    expect(escapeTsvCell("")).toBe("");
  });

  it("handles strings with only special characters", () => {
    expect(escapeTsvCell("\t\n\r")).toBe("\\t\\n\\r");
  });

  it("handles strings with only backslashes", () => {
    expect(escapeTsvCell("\\\\")).toBe("\\\\\\\\");
  });

  it("does not modify other whitespace", () => {
    expect(escapeTsvCell("  spaces  ")).toBe("  spaces  ");
  });
});

// ---------------------------------------------------------------------------
// isMissingFileError
// ---------------------------------------------------------------------------
describe("isMissingFileError", () => {
  it("returns true for ENOENT errors", () => {
    const err = new Error("ENOENT: no such file");
    (err as any).code = "ENOENT";
    expect(isMissingFileError(err)).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isMissingFileError(new Error("something else"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isMissingFileError("not an error")).toBe(false);
    expect(isMissingFileError(null)).toBe(false);
    expect(isMissingFileError(undefined)).toBe(false);
  });
});
