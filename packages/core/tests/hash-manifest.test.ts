import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HASH_MANIFEST_RELATIVE_PATH,
  buildTransitiveHash,
  hashManifestSha256,
  posixNormalize,
  readHashManifest,
  sha256OfFileOrNull,
  stripVolatileConfigFields,
  writeAtomic,
  writeHashManifest,
  type HashManifest,
  type ParsedFileLike,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("buildTransitiveHash", () => {
  it("computes own_hash * sorted deps' transitive_hash", () => {
    // A imports B, B has no deps. transitive_hash(B) = sha256(own(B) + "|"),
    // transitive_hash(A) = sha256(own(A) + "|" + transitive_hash(B)).
    const files = new Map<string, ParsedFileLike>();
    files.set("a.stele", makeFile("a.stele", "(invariant A (severity high) (description \"a\") (assert (eq 1 1)))", ["b.stele"]));
    files.set("b.stele", makeFile("b.stele", "(invariant B (severity high) (description \"b\") (assert (eq 2 2)))", []));

    const dag = new Map<string, string[]>([
      ["a.stele", ["b.stele"]],
      ["b.stele", []],
    ]);

    const result = buildTransitiveHash(files, dag);

    const ownA = hashManifestSha256(files.get("a.stele")!.normalized);
    const ownB = hashManifestSha256(files.get("b.stele")!.normalized);
    const expectedB = hashManifestSha256(`${ownB}|`);
    const expectedA = hashManifestSha256(`${ownA}|${expectedB}`);

    expect(result.get("b.stele")).toBe(expectedB);
    expect(result.get("a.stele")).toBe(expectedA);
  });

  it("sorts dep hashes deterministically", () => {
    // Two leaves B and C with different own hashes. Build twice with deps in
    // different declared order; result must be identical.
    const filesAsc = new Map<string, ParsedFileLike>();
    filesAsc.set("a.stele", makeFile("a.stele", "A", ["b.stele", "c.stele"]));
    filesAsc.set("b.stele", makeFile("b.stele", "BB"));
    filesAsc.set("c.stele", makeFile("c.stele", "CCC"));

    const filesDesc = new Map<string, ParsedFileLike>();
    filesDesc.set("a.stele", makeFile("a.stele", "A", ["c.stele", "b.stele"]));
    filesDesc.set("b.stele", makeFile("b.stele", "BB"));
    filesDesc.set("c.stele", makeFile("c.stele", "CCC"));

    const ascResult = buildTransitiveHash(
      filesAsc,
      new Map([
        ["a.stele", ["b.stele", "c.stele"]],
        ["b.stele", []],
        ["c.stele", []],
      ]),
    );
    const descResult = buildTransitiveHash(
      filesDesc,
      new Map([
        ["a.stele", ["c.stele", "b.stele"]],
        ["b.stele", []],
        ["c.stele", []],
      ]),
    );

    expect(ascResult.get("a.stele")).toBe(descResult.get("a.stele"));
  });

  it("topologically sorts so leaves are computed before parents", () => {
    // Non-trivial DAG: A -> B -> C, A -> C. Should not throw; should produce
    // valid hashes for all.
    const files = new Map<string, ParsedFileLike>();
    files.set("a.stele", makeFile("a.stele", "A", ["b.stele", "c.stele"]));
    files.set("b.stele", makeFile("b.stele", "B", ["c.stele"]));
    files.set("c.stele", makeFile("c.stele", "C"));

    const dag = new Map<string, string[]>([
      ["a.stele", ["b.stele", "c.stele"]],
      ["b.stele", ["c.stele"]],
      ["c.stele", []],
    ]);

    const result = buildTransitiveHash(files, dag);
    expect(result.size).toBe(3);
    expect(result.get("a.stele")).toBeDefined();
    expect(result.get("b.stele")).toBeDefined();
    expect(result.get("c.stele")).toBeDefined();
  });

  it("throws on cyclic DAG", () => {
    const files = new Map<string, ParsedFileLike>();
    files.set("a.stele", makeFile("a.stele", "A", ["b.stele"]));
    files.set("b.stele", makeFile("b.stele", "B", ["a.stele"]));

    const dag = new Map<string, string[]>([
      ["a.stele", ["b.stele"]],
      ["b.stele", ["a.stele"]],
    ]);

    expect(() => buildTransitiveHash(files, dag)).toThrow(/cycle/i);
  });
});

describe("readHashManifest / writeHashManifest round-trip", () => {
  it("writes and reads back identical manifest", async () => {
    const dir = await createTempDir();
    const manifest: HashManifest = {
      version: "1",
      generated_at: "2026-05-08T12:00:00.000Z",
      stele_version: "0.1.0",
      backend: "python",
      operator_registry_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      files: {
        "contract/main.stele": {
          own_hash: "c".repeat(64),
          transitive_hash: "d".repeat(64),
          deps: [],
          output_paths: [],
          output_hashes: {},
        },
      },
      output_hashes_global: {
        "tests/contract/test_contract.py": "e".repeat(64),
      },
    };

    await writeHashManifest(dir, manifest);
    const restored = await readHashManifest(dir);

    expect(restored).not.toBeNull();
    expect(restored).toEqual(manifest);
  });

  it("returns null when manifest is missing", async () => {
    const dir = await createTempDir();
    const result = await readHashManifest(dir);
    expect(result).toBeNull();
  });

  it("returns null when manifest contains malformed JSON", async () => {
    const dir = await createTempDir();
    const cachePath = join(dir, HASH_MANIFEST_RELATIVE_PATH);
    await writeAtomic(cachePath, "not valid json");
    const result = await readHashManifest(dir);
    expect(result).toBeNull();
  });

  it("returns null when manifest has wrong shape", async () => {
    const dir = await createTempDir();
    const cachePath = join(dir, HASH_MANIFEST_RELATIVE_PATH);
    await writeAtomic(cachePath, JSON.stringify({ unrelated: true }));
    const result = await readHashManifest(dir);
    expect(result).toBeNull();
  });
});

describe("writeAtomic", () => {
  it("writes the file with the expected content", async () => {
    const dir = await createTempDir();
    const target = join(dir, "nested/path/file.txt");
    await writeAtomic(target, "hello world");

    await expect(readFile(target, "utf8")).resolves.toBe("hello world");
  });

  it("creates parent directories as needed", async () => {
    const dir = await createTempDir();
    const target = join(dir, "a/b/c/file.txt");
    await writeAtomic(target, "x");

    await expect(stat(target)).resolves.toBeDefined();
  });

  it("does not leave behind .tmp files after a successful write", async () => {
    const dir = await createTempDir();
    const target = join(dir, "atomic.txt");
    await writeAtomic(target, "first");
    await writeAtomic(target, "second");

    // Find any leftover .tmp.* siblings.
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir);
    expect(entries.filter((entry) => entry.includes(".tmp."))).toEqual([]);
    await expect(readFile(target, "utf8")).resolves.toBe("second");
  });

  it("overwrites existing files", async () => {
    const dir = await createTempDir();
    const target = join(dir, "existing.txt");
    await writeFile(target, "old");
    await writeAtomic(target, "new");

    await expect(readFile(target, "utf8")).resolves.toBe("new");
  });
});

describe("sha256OfFileOrNull", () => {
  it("returns SHA-256 of file content", async () => {
    const dir = await createTempDir();
    const target = join(dir, "data.bin");
    await writeFile(target, "abc");

    const hash = await sha256OfFileOrNull(target);
    // SHA-256("abc") = ba7816bf...
    expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("returns null when file does not exist", async () => {
    const dir = await createTempDir();
    const result = await sha256OfFileOrNull(join(dir, "missing.bin"));
    expect(result).toBeNull();
  });
});

describe("stripVolatileConfigFields", () => {
  it("strips _generated_at and generated_at", () => {
    const input = { a: 1, _generated_at: "now", generated_at: "later", b: 2 };
    expect(stripVolatileConfigFields(input)).toEqual({ a: 1, b: 2 });
  });

  it("preserves all other fields", () => {
    const input = { contractDir: "contract", entry: "contract/main.stele", protected: ["a", "b"] };
    expect(stripVolatileConfigFields(input)).toEqual(input);
  });
});

describe("posixNormalize", () => {
  it("converts backslashes to forward slashes", () => {
    expect(posixNormalize("a\\b\\c")).toBe("a/b/c");
  });

  it("leaves posix paths unchanged", () => {
    expect(posixNormalize("a/b/c")).toBe("a/b/c");
  });
});

function makeFile(relativePath: string, normalized: string, deps: string[] = []): ParsedFileLike {
  return {
    relativePath,
    absolutePath: `/abs/${relativePath}`,
    normalized,
    deps: deps.slice().sort(),
  };
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hash-manifest-"));
  tempDirs.push(directory);
  return directory;
}
