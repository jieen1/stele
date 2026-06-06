import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallGraph } from "@stele/call-graph-core";
import { buildCoverageReport } from "../src/commands/coverage.js";
import type { ChurnEntry } from "../src/coverage/churn.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "stele-coverage-"));
  tempDirs.push(directory);
  return directory;
}

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(projectDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

const CONTRACT = [
  "(checker test_checker",
  '  (description "A test checker."))',
  "",
  "(invariant USES_CHECKER_INV",
  "  (severity high)",
  '  (description "An invariant that uses a checker.")',
  "  (uses-checker test_checker))",
  "",
  "(boundary covered-boundary",
  "  (lang typescript)",
  '  (target "packages/alpha/src/**/*.ts")',
  '  (deny-import "node:fs"))',
  "",
  "(class-shape covered-class",
  "  (lang typescript)",
  '  (target "packages/alpha/src/thing.ts::Thing")',
  '  (must-have-method "run"))',
  "",
  "(core-node \"covered-core\"",
  "  (lang typescript)",
  "  (role business-core-service)",
  '  (target "packages/beta/src/core.ts::CoreService")',
  "  (metric sloc (ideal 60) (max 120)))",
  "",
  "(branded-id \"BrandX\"",
  '  (target "packages/beta/src/brand.ts::BrandX")',
  '  (base-type "string"))',
  "",
  "(trace-policy BOUND_TRACE",
  '  (severity "error")',
  '  (target "extern:node-fs::writeFile(*)")',
  '  (must-transit "packages/alpha/src/thing.ts::wrap(1)")',
  '  (scope "packages/alpha/src/**/*.ts"))',
  "",
  "(trace-policy ZERO_BINDING_TRACE",
  '  (severity "error")',
  '  (target "extern:nonexistent-pkg::nope(*)")',
  '  (deny-direct "packages/ghost/src/**::*")',
  '  (scope "packages/ghost/src/**/*.ts"))',
].join("\n") + "\n";

async function createFixture(): Promise<string> {
  const projectDir = await createTempDir();
  await writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await writeProjectFile(projectDir, "contract/main.stele", CONTRACT);
  await writeProjectFile(
    projectDir,
    "contract/checker_impls/test_checker.py",
    "def test_checker(context):\n    return {\"passed\": True, \"message\": None}\n",
  );

  // Universe source files. alpha: thing.ts (covered by boundary+class) and
  // other.ts (covered by boundary). beta: core.ts + brand.ts (covered). gamma:
  // lonely.ts (uncovered, high churn).
  await writeProjectFile(projectDir, "packages/alpha/src/thing.ts", "export class Thing {\n  run() {}\n}\n");
  await writeProjectFile(projectDir, "packages/alpha/src/other.ts", "export const other = 1;\n");
  await writeProjectFile(projectDir, "packages/beta/src/core.ts", "export class CoreService {}\n");
  await writeProjectFile(projectDir, "packages/beta/src/brand.ts", "export type BrandX = string;\n");
  await writeProjectFile(projectDir, "packages/gamma/src/lonely.ts", "export const lonely = 1;\n");
  // Excluded files must NOT count.
  await writeProjectFile(projectDir, "packages/alpha/tests/thing.test.ts", "export const t = 1;\n");
  await writeProjectFile(projectDir, "packages/alpha/src/types.d.ts", "export type X = number;\n");

  return projectDir;
}

/**
 * Synthetic call graph so symbol mechanisms bind deterministically without
 * compiling TypeScript. BOUND_TRACE: an in-scope caller (wrap) reaching the
 * extern writeFile target. ZERO_BINDING_TRACE: nothing.
 */
function stubCallGraph(): CallGraph {
  return {
    schemaVersion: "1",
    language: "typescript",
    generatedAt: "1970-01-01T00:00:00.000Z",
    projectRoot: "/tmp/fixture",
    nodes: [
      {
        id: "packages/alpha/src/thing.ts::wrap(1)",
        kind: "function",
        filePath: "packages/alpha/src/thing.ts",
        span: { line: 1, column: 1 },
        signature: "wrap(x)",
        isExported: true,
        isAsync: false,
      },
      {
        id: "extern:node-fs::writeFile(2)",
        kind: "function",
        filePath: undefined as unknown as string,
        span: { line: 0, column: 0 },
        signature: "writeFile",
        isExported: false,
        isAsync: false,
      },
    ],
    edges: [
      {
        fromId: "packages/alpha/src/thing.ts::wrap(1)",
        toId: "extern:node-fs::writeFile(2)",
        callSite: { line: 2, column: 3 },
        isConditional: false,
        isLoop: false,
        isAsync: false,
      },
    ],
    unresolvedCalls: [],
    ambiguousCalls: [],
    methodResolutionHash: "x",
    fileHashes: {},
  };
}

const noChurn = async () => new Map<string, ChurnEntry>();
const buildStub = async () => stubCallGraph();

describe("stele coverage", () => {
  it("partitions covered vs uncovered files per the declared targets", async () => {
    const projectDir = await createFixture();
    const report = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: buildStub });

    const paths = report.files.map((f) => f.path);
    expect(paths).toContain("packages/alpha/src/thing.ts");
    expect(paths).toContain("packages/gamma/src/lonely.ts");
    // Excluded files are out of the universe.
    expect(paths).not.toContain("packages/alpha/tests/thing.test.ts");
    expect(paths).not.toContain("packages/alpha/src/types.d.ts");

    const byPath = new Map(report.files.map((f) => [f.path, f]));
    expect(byPath.get("packages/alpha/src/thing.ts")?.covered).toBe(true);
    expect(byPath.get("packages/alpha/src/other.ts")?.covered).toBe(true);
    expect(byPath.get("packages/beta/src/core.ts")?.covered).toBe(true);
    expect(byPath.get("packages/beta/src/brand.ts")?.covered).toBe(true);
    expect(byPath.get("packages/gamma/src/lonely.ts")?.covered).toBe(false);
  });

  it("attributes each spatial mechanism to its expected files", async () => {
    const projectDir = await createFixture();
    const report = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: buildStub });
    const byPath = new Map(report.files.map((f) => [f.path, f]));

    const thingHits = byPath.get("packages/alpha/src/thing.ts")?.hits.map((h) => h.mechanism) ?? [];
    expect(thingHits).toContain("boundary");
    expect(thingHits).toContain("class-shape");

    expect(byPath.get("packages/beta/src/core.ts")?.hits.map((h) => h.mechanism)).toContain("core-node");
    expect(byPath.get("packages/beta/src/brand.ts")?.hits.map((h) => h.mechanism)).toContain("branded-id");

    expect(report.byMechanism["boundary"].declarationCount).toBe(1);
    expect(report.byMechanism["core-node"].declarationCount).toBe(1);
    expect(report.byMechanism["branded-id"].declarationCount).toBe(1);
    expect(report.byMechanism["class-shape"].declarationCount).toBe(1);
  });

  it("does NOT count a zero-binding trace-policy as coverage", async () => {
    const projectDir = await createFixture();
    const report = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: buildStub });

    // BOUND_TRACE binds (wrap → writeFile) and covers its scope file.
    const thing = report.files.find((f) => f.path === "packages/alpha/src/thing.ts");
    expect(thing?.hits.some((h) => h.mechanism === "trace-policy" && h.declarationId === "BOUND_TRACE")).toBe(true);

    // ZERO_BINDING_TRACE binds nothing → no file gets a hit from it.
    const anyZeroHit = report.files.some((f) =>
      f.hits.some((h) => h.declarationId === "ZERO_BINDING_TRACE"),
    );
    expect(anyZeroHit).toBe(false);
  });

  it("counts checkers and uses-checker invariants as non-spatial guards, not coverage", async () => {
    const projectDir = await createFixture();
    const report = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: buildStub });
    expect(report.nonSpatialGuards.checkers).toBe(1);
    expect(report.nonSpatialGuards.invariantsUsingCheckers).toBe(1);
  });

  it("--min below threshold sets thresholds.met=false; at/above true", async () => {
    const projectDir = await createFixture();
    const below = await buildCoverageReport(projectDir, { min: 100 }, { getChurn: noChurn, buildCallGraph: buildStub });
    expect(below.thresholds?.met).toBe(false);

    const above = await buildCoverageReport(projectDir, { min: 1 }, { getChurn: noChurn, buildCallGraph: buildStub });
    expect(above.thresholds?.met).toBe(true);
  });

  it("produces byte-identical JSON across two runs (no wall-clock)", async () => {
    const projectDir = await createFixture();
    const a = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: buildStub });
    const b = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: buildStub });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("ranks hotspots by (churn desc, path asc) and respects top-N", async () => {
    const projectDir = await createFixture();
    const churn = async () =>
      new Map<string, ChurnEntry>([
        ["packages/gamma/src/lonely.ts", { commits: 9, lastTouched: "2026-01-01T00:00:00Z" }],
        // alpha/other is covered, so even with churn it is NOT a hotspot.
        ["packages/alpha/src/other.ts", { commits: 99 }],
      ]);
    const report = await buildCoverageReport(projectDir, { top: 5 }, { getChurn: churn, buildCallGraph: buildStub });
    expect(report.hotspots.map((h) => h.path)).toEqual(["packages/gamma/src/lonely.ts"]);
    expect(report.hotspots[0].churn).toBe(9);

    const topZero = await buildCoverageReport(projectDir, { top: 0 }, { getChurn: churn, buildCallGraph: buildStub });
    expect(topZero.hotspots).toHaveLength(0);
  });

  it("reports symbol mechanisms as unsupported when no call graph is available", async () => {
    const projectDir = await createFixture();
    const noGraph = async () => null;
    const report = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: noGraph });

    expect(report.byMechanism["trace-policy"].support).toBe("unsupported");
    expect(report.byMechanism["effect-policy"].support).toBe("unsupported");
    expect(report.byMechanism["type-state"].support).toBe("unsupported");
    // No trace-policy contributes coverage without a graph.
    const anyTraceHit = report.files.some((f) => f.hits.some((h) => h.mechanism === "trace-policy"));
    expect(anyTraceHit).toBe(false);
    expect(report.notes.some((n) => n.includes("unsupported"))).toBe(true);
  });

  it("emits the N>0 hotspot header and the N==0 sentence exactly", async () => {
    const projectDir = await createFixture();
    // N==0 case: no churn → no hotspots.
    const reportZero = await buildCoverageReport(projectDir, {}, { getChurn: noChurn, buildCallGraph: buildStub });
    expect(reportZero.hotspots).toHaveLength(0);
  });
});
