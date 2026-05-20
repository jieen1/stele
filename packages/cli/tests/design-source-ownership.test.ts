import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateSourceOwnership } from "../src/design-generator/ownership.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-src-ownership-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Create a standard fixture directory structure:
 *
 * src/
 * ├── a/
 * │   ├── file1.txt
 * │   └── nested/
 * │       └── file2.txt
 * ├── b/
 * │   └── file3.txt
 * ├── shared/
 * │   └── utils.txt
 * ├── generated/
 * │   └── auto.txt
 * └── leftover.txt
 */
async function createFixture(dir: string): Promise<void> {
  const files = [
    "src/a/file1.txt",
    "src/a/nested/file2.txt",
    "src/b/file3.txt",
    "src/shared/utils.txt",
    "src/generated/auto.txt",
    "src/leftover.txt",
  ];

  for (const file of files) {
    const fullPath = join(dir, file);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, `content of ${file}`, "utf8");
  }
}

// ---------------------------------------------------------------------------
// All files owned — valid
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — all files owned", () => {
  it("reports valid when all source files belong to a context or kernel", async () => {
    const dir = await createTempDir();
    await createFixture(dir);

    const result = validateSourceOwnership(
      dir,
      ["src"],
      ["src/a", "src/b"],
      ["src/shared/**/*"],
      ["src/generated/**/*", "src/leftover.txt"],
    );

    expect(result.valid).toBe(true);
    expect(result.unowned).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Shared kernel ownership
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — shared kernel ownership", () => {
  it("recognizes files matched by shared kernel glob patterns", async () => {
    const dir = await createTempDir();
    await createFixture(dir);

    const result = validateSourceOwnership(
      dir,
      ["src"],
      ["src/a", "src/b"],
      ["src/shared/**/*"],
      ["src/generated/**/*", "src/leftover.txt"],
    );

    expect(result.valid).toBe(true);
    expect(result.unowned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ignore patterns
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — ignore patterns", () => {
  it("excludes files matching ignore patterns from ownership checks", async () => {
    const dir = await createTempDir();
    await createFixture(dir);

    const result = validateSourceOwnership(
      dir,
      ["src"],
      ["src/a", "src/b"],
      ["src/shared/**/*"],
      ["src/generated/**/*", "src/leftover.txt"],
    );

    expect(result.valid).toBe(true);
    expect(result.unowned).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unowned files
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — unowned files", () => {
  it("detects files not covered by any context or shared kernel", async () => {
    const dir = await createTempDir();
    await createFixture(dir);

    // src/leftover.txt is not owned by any context/kernel and is NOT ignored
    const result = validateSourceOwnership(
      dir,
      ["src"],
      ["src/a", "src/b"],
      ["src/shared/**/*"],
      ["src/generated/**/*"],
    );

    expect(result.valid).toBe(false);
    expect(result.unowned).toContain("src/leftover.txt");
    expect(result.ambiguous).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ambiguous ownership
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — ambiguous ownership", () => {
  it("detects files matching both a context root and a shared kernel", async () => {
    const dir = await createTempDir();
    await createFixture(dir);

    // Broad shared kernel pattern that overlaps with context src/a and src/b
    const result = validateSourceOwnership(
      dir,
      ["src"],
      ["src/a", "src/b"],
      ["src/**/*"],
      ["src/generated/**/*", "src/leftover.txt"],
    );

    expect(result.valid).toBe(false);
    expect(result.ambiguous).toContain("src/a/file1.txt");
    expect(result.ambiguous).toContain("src/a/nested/file2.txt");
    expect(result.ambiguous).toContain("src/b/file3.txt");
    expect(result.unowned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Empty source
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — empty source", () => {
  it("returns valid when there are no source files", async () => {
    const dir = await createTempDir();
    // No files created

    const result = validateSourceOwnership(
      dir,
      ["src"],
      ["src/a"],
      [],
      [],
    );

    expect(result.valid).toBe(true);
    expect(result.unowned).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multiple source roots
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — multiple source roots", () => {
  it("collects files from multiple source roots", async () => {
    const dir = await createTempDir();

    // Create files in two source roots
    const files = [
      "src1/a/file1.txt",
      "src2/b/file2.txt",
    ];

    for (const file of files) {
      const fullPath = join(dir, file);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, `content of ${file}`, "utf8");
    }

    const result = validateSourceOwnership(
      dir,
      ["src1", "src2"],
      ["src1/a", "src2/b"],
      [],
      [],
    );

    expect(result.valid).toBe(true);
    expect(result.unowned).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wildcard ignore patterns
// ---------------------------------------------------------------------------

describe("validateSourceOwnership — wildcard ignore patterns", () => {
  it("supports glob patterns in ignore list", async () => {
    const dir = await createTempDir();
    await createFixture(dir);

    const result = validateSourceOwnership(
      dir,
      ["src"],
      ["src/a", "src/b"],
      ["src/shared/**/*"],
      ["src/generated/**/*", "src/**/*.spec.txt", "src/leftover.txt"],
    );

    expect(result.valid).toBe(true);
    expect(result.unowned).toEqual([]);
  });
});
