import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tsCallGraphExtractor } from "../../src/extractors/call-graph.js";

import { fixturePath } from "./_helpers.js";

let tempRoot = "";

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "stele-cg-cache-"));
  cpSync(fixturePath("incremental-base"), tempRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("tsCallGraphExtractor — incremental cache", () => {
  it("non-incremental extract produces the same nodes as incremental extract with empty change set", async () => {
    const base = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    const incr = await tsCallGraphExtractor.extractIncremental({
      projectRoot: tempRoot,
      previous: base,
      changedFiles: [],
    });
    expect(incr.nodes.map((n) => n.id)).toEqual(base.nodes.map((n) => n.id));
    expect(incr.edges).toEqual(base.edges);
  });

  it("fileHashes contains every visited source file", async () => {
    const g = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    expect(Object.keys(g.fileHashes).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("changing a file produces a new SHA-256 in fileHashes", async () => {
    const g1 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    writeFileSync(
      join(tempRoot, "src/a.ts"),
      `export function a(): number {
  return 99;
}
`,
    );
    const g2 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    expect(g2.fileHashes["src/a.ts"]).not.toBe(g1.fileHashes["src/a.ts"]);
    expect(g2.fileHashes["src/b.ts"]).toBe(g1.fileHashes["src/b.ts"]);
  });

  it("incremental re-extract re-parses changed files and keeps unchanged ones", async () => {
    const g1 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    writeFileSync(
      join(tempRoot, "src/a.ts"),
      `export function a(): number {
  return 99;
}
`,
    );
    const g2 = await tsCallGraphExtractor.extractIncremental({
      projectRoot: tempRoot,
      previous: g1,
      changedFiles: ["src/a.ts"],
    });
    // a still has its node and the b → a edge still exists.
    expect(g2.nodes.find((n) => n.id === "src/index.ts::a(0)" || n.id === "src/a.ts::a(0)")).toBeDefined();
    expect(g2.edges.find((e) => e.toId === "src/a.ts::a(0)")).toBeDefined();
  });

  it("methodResolutionHash is stable when no class hierarchy changed", async () => {
    const g1 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    writeFileSync(
      join(tempRoot, "src/a.ts"),
      `export function a(): number {
  return 99;
}
`,
    );
    const g2 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    expect(g2.methodResolutionHash).toBe(g1.methodResolutionHash);
  });

  it("incremental extract with no changes returns byte-identical graph data (excluding timestamp)", async () => {
    const g1 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    const g2 = await tsCallGraphExtractor.extractIncremental({
      projectRoot: tempRoot,
      previous: g1,
      changedFiles: [],
    });
    expect(g2.nodes).toEqual(g1.nodes);
    expect(g2.edges).toEqual(g1.edges);
    expect(g2.unresolvedCalls).toEqual(g1.unresolvedCalls);
    expect(g2.ambiguousCalls).toEqual(g1.ambiguousCalls);
    expect(g2.fileHashes).toEqual(g1.fileHashes);
  });

  it("sha256File output is prefixed with sha256-", async () => {
    const g = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    for (const v of Object.values(g.fileHashes)) {
      expect(v.startsWith("sha256-")).toBe(true);
      expect(v.length).toBe(7 + 64);
    }
  });

  it("two distinct projectRoots produce different absolute projectRoot fields", async () => {
    const g1 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    const g2 = await tsCallGraphExtractor.extract({ projectRoot: fixturePath("simple-direct-call") });
    expect(g1.projectRoot).not.toBe(g2.projectRoot);
    expect(g1.fileHashes).not.toEqual(g2.fileHashes);
  });

  it("changing a function body changes that file's hash but not other files'", async () => {
    const g1 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    const aHashBefore = g1.fileHashes["src/a.ts"];
    const bHashBefore = g1.fileHashes["src/b.ts"];
    writeFileSync(
      join(tempRoot, "src/a.ts"),
      `export function a(): number {
  return 42;
}
`,
    );
    const g2 = await tsCallGraphExtractor.extract({ projectRoot: tempRoot });
    expect(g2.fileHashes["src/a.ts"]).not.toBe(aHashBefore);
    expect(g2.fileHashes["src/b.ts"]).toBe(bHashBefore);
  });
});
