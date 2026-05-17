import { describe, expect, it } from "vitest";
import {
  collectExistingGeneratedEntries,
  walkGeneratedDirectory,
  readGeneratedFile,
  verifyFiles,
} from "../src/generator/file-walk.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExistingGeneratedEntry } from "../src/generator/file-walk.js";

describe("collectExistingGeneratedEntries", () => {
  it("returns empty array for non-existent directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const entries = await collectExistingGeneratedEntries(project, "nonexistent");
      expect(entries).toEqual([]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("returns empty array for non-directory path", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const file = join(project, "myfile.txt");
      await writeFile(file, "content");
      const entries = await collectExistingGeneratedEntries(project, "myfile.txt");
      expect(entries).toEqual([]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("returns entries for existing directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "test1.py"), "content1");
      await writeFile(join(dir, "test2.py"), "content2");

      const entries = await collectExistingGeneratedEntries(project, "output");
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.path)).toContain("output/test1.py");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("walkGeneratedDirectory", () => {
  it("walks directory recursively", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      const subdir = join(dir, "sub");
      await mkdir(subdir, { recursive: true });
      await writeFile(join(dir, "a.py"), "content");
      await writeFile(join(subdir, "b.py"), "content");

      const entries = await walkGeneratedDirectory(dir, project);
      expect(entries).toHaveLength(2);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("identifies symlinks as non-regular", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });
      await writeFile(join(project, "target.txt"), "target");

      const entries = await walkGeneratedDirectory(dir, project);
      expect(entries).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("entries are sorted", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "z.py"), "z");
      await writeFile(join(dir, "a.py"), "a");

      const entries = await walkGeneratedDirectory(dir, project);
      expect(entries.map((e) => e.path)).toEqual([
        "output/a.py",
        "output/z.py",
      ]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("readGeneratedFile", () => {
  it("reads file content", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      await writeFile(join(project, "test.py"), "hello world");
      const content = await readGeneratedFile(project, "test.py");
      expect(content).toBe("hello world");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});

describe("verifyFiles", () => {
  it("detects matching files", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "test.py"), "expected");

      const result = await verifyFiles(project, "output", [
        { path: "output/test.py", content: "expected" },
      ]);

      expect(result.ok).toBe(true);
      expect(result.unchanged).toContain("output/test.py");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("detects changed files", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "test.py"), "changed");

      const result = await verifyFiles(project, "output", [
        { path: "output/test.py", content: "expected" },
      ]);

      expect(result.ok).toBe(false);
      expect(result.changed).toContain("output/test.py");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("detects missing files", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });

      const result = await verifyFiles(project, "output", [
        { path: "output/test.py", content: "expected" },
      ]);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain("output/test.py");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("detects extra files", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "extra.py"), "content");

      const result = await verifyFiles(project, "output", []);

      expect(result.ok).toBe(false);
      expect(result.extra).toContain("output/extra.py");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("result files are sorted by path", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-test-"));
    try {
      const dir = join(project, "output");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "z.py"), "z");
      await writeFile(join(dir, "a.py"), "a");

      const result = await verifyFiles(project, "output", [
        { path: "output/z.py", content: "z" },
        { path: "output/a.py", content: "a" },
      ]);

      expect(result.files.map((f) => f.path)).toEqual(["output/a.py", "output/z.py"]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
