/**
 * Tests for `stele explain effect <NodeId>` (Phase B T5.6).
 *
 * Coverage:
 *
 *   - Empty contract (no effect-policy) → tells the user, exits 0.
 *   - Unknown NodeId → diagnostic with exit code 2.
 *   - Node with no effects on it → "no effects" branch, exits 0.
 *   - Node with direct effects → human output lists them under "Direct".
 *   - Node with inherited effects → "Effective" + propagation chain rendered.
 *   - Applicable policies are listed with violation counts.
 *   - JSON mode emits all top-level keys.
 *   - `--no-cache` re-extracts the call graph (extractor called twice).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { tsCallGraphExtractor } from "@stele/backend-typescript";
import type { CallGraph } from "@stele/call-graph-core";

import {
  runExplainEffect,
  type ExplainEffectDeps,
} from "../src/commands/explain-effect.js";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../src/config/defaults.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-explain-effect-"));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFile(projectDir: string, relativePath: string, content: string): void {
  const fullPath = join(projectDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function writeBaseConfig(projectDir: string): void {
  const config = { ...DEFAULT_CONFIG, targetLanguage: "typescript" };
  writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

function writeTsconfig(projectDir: string): void {
  writeProjectFile(
    projectDir,
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          noEmit: true,
          allowJs: false,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

// ----------------------------------------------------------------
// Shared fixture set — pre-extracted call graph cached at module
// scope so each test reuses without repeating tsCallGraphExtractor
// work (which is slow). Each test still gets a fresh contract.
// ----------------------------------------------------------------

interface PropagationFixture {
  readonly projectDir: string;
  readonly callGraph: CallGraph;
  readonly uiNodeId: string;
  readonly dbNodeId: string;
}

let cachedPropagationFixture: PropagationFixture | undefined;

async function buildPropagationFixture(): Promise<PropagationFixture> {
  if (cachedPropagationFixture !== undefined) {
    return cachedPropagationFixture;
  }

  const projectDir = await createTempProject();
  // Don't auto-delete this one — we cache it across tests.
  tempDirs.pop();

  writeBaseConfig(projectDir);
  writeTsconfig(projectDir);
  writeProjectFile(
    projectDir,
    "src/db.ts",
    [
      "/** @stele:effects db.read */",
      "export function findUser(id: string): { id: string; name: string } {",
      "  return { id, name: `user-${id}` };",
      "}",
      "",
    ].join("\n"),
  );
  writeProjectFile(
    projectDir,
    "src/components/UserCard.ts",
    [
      'import { findUser } from "../db.js";',
      "",
      "export function UserCard(props: { id: string }): string {",
      "  const user = findUser(props.id);",
      "  return `<div>${user.name}</div>`;",
      "}",
      "",
    ].join("\n"),
  );
  writeProjectFile(
    projectDir,
    "contract/main.stele",
    [
      "(metadata",
      '  (stele-version "0.1")',
      '  (project "explain-effect-test"))',
      "",
      "(effect-declarations",
      '  (effect "db.read" (description "Reading from database"))',
      '  (effect "db.write")',
      '  (effect "http.outgoing"))',
      "",
      "(effect-annotation",
      '  (target "src/db.ts::findUser(*)")',
      '  (annotates "db.read"))',
      "",
      "(effect-policy NO_IO_IN_UI",
      '  (description "UI components must be pure render functions.")',
      '  (target-scope "src/components/**::*")',
      '  (forbid "db.read" "db.write" "http.outgoing")',
      '  (severity "error")',
      '  (fix-hint "Move IO out of `UserCard` into a route loader."))',
      "",
    ].join("\n"),
  );

  const callGraph = await tsCallGraphExtractor.extract({
    projectRoot: projectDir,
    tsconfigPath: resolve(projectDir, "tsconfig.json"),
  });

  const uiNode = callGraph.nodes.find((n) => n.id.includes("UserCard"));
  const dbNode = callGraph.nodes.find((n) => n.id.includes("findUser"));
  if (uiNode === undefined || dbNode === undefined) {
    throw new Error(
      `Fixture extraction missed expected nodes. Got: ${callGraph.nodes.map((n) => n.id).join(", ")}`,
    );
  }

  cachedPropagationFixture = {
    projectDir,
    callGraph,
    uiNodeId: uiNode.id,
    dbNodeId: dbNode.id,
  };
  return cachedPropagationFixture;
}

function depsServingCachedGraph(fixture: PropagationFixture): ExplainEffectDeps {
  return {
    extractCallGraph: async () => fixture.callGraph,
  };
}

beforeAll(async () => {
  await buildPropagationFixture();
});

afterEach(async () => {
  // Clean up the cached project (cachedPropagationFixture) only when the
  // process exits — vitest does not call beforeAll between tests, so we
  // keep this fixture across the file's lifetime.
});

// ============================================================================
// Tests
// ============================================================================

describe("runExplainEffect", () => {
  it("reports node not found with a non-zero exit code", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(
      fixture.projectDir,
      "does/not/exist.ts::NoSuchNode(0)",
      {},
      deps,
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("was not found in the project's call graph");
  });

  it("emits node_not_found JSON error with exit code 2", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(
      fixture.projectDir,
      "src/missing.ts::ghost(0)",
      { json: true },
      deps,
    );

    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(result.output);
    expect(parsed.error).toBe("node_not_found");
    expect(parsed.node_id).toBe("src/missing.ts::ghost(0)");
  });

  it("renders direct effects on the declaring node", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(fixture.projectDir, fixture.dbNodeId, {}, deps);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Effect inspection for node:");
    expect(result.output).toContain(fixture.dbNodeId);
    expect(result.output).toContain("Direct effects on this node:");
    expect(result.output).toContain("- db.read");
    // db.read is direct, not inherited, so no propagation chain through callees.
    expect(result.output).toContain("Effective effects (after propagation):");
  });

  it("renders inherited effects and a multi-step propagation chain on the caller", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(fixture.projectDir, fixture.uiNodeId, {}, deps);

    expect(result.exitCode).toBe(0);
    // UserCard does not declare anything itself.
    expect(result.output).toContain("Direct effects on this node:");
    expect(result.output).toContain("(none — all effects below are inherited)");
    // db.read inherited from findUser.
    expect(result.output).toContain("db.read");
    expect(result.output).toContain("[inherited]");
    expect(result.output).toContain("Propagation chains:");
    expect(result.output).toContain("db.read:");
    // Chain has at least one arrow and reaches the declarer.
    expect(result.output).toContain("→ ");
    expect(result.output).toContain("declares: db.read");
  });

  it("lists applicable policies with a violation count for in-scope nodes", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(fixture.projectDir, fixture.uiNodeId, {}, deps);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Applicable policies (in scope):");
    expect(result.output).toContain("NO_IO_IN_UI");
    expect(result.output).toContain("forbids");
    // db.read is forbidden and present in effective set → at least 1 violation would fire.
    expect(result.output).toMatch(/[1-9]\d* violation/);
  });

  it("shows '(none)' policy section when contract declares no effect-policy", async () => {
    const projectDir = await createTempProject();
    writeBaseConfig(projectDir);
    writeTsconfig(projectDir);
    writeProjectFile(
      projectDir,
      "src/index.ts",
      [
        "export function noop(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    );
    writeProjectFile(
      projectDir,
      "contract/main.stele",
      [
        "(metadata",
        '  (stele-version "0.1")',
        '  (project "explain-effect-no-policy"))',
        "",
        "(effect-declarations",
        '  (effect "db.read"))',
        "",
      ].join("\n"),
    );

    // Real extraction here — graph is tiny.
    const result = await runExplainEffect(projectDir, "src/index.ts::noop(0)", {});

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("no effect-policy declared in contract");
  });

  it("emits valid JSON with all required top-level keys", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(
      fixture.projectDir,
      fixture.uiNodeId,
      { json: true },
      deps,
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.command).toBe("explain effect");
    expect(parsed.node.id).toBe(fixture.uiNodeId);
    expect(Array.isArray(parsed.direct_effects)).toBe(true);
    expect(Array.isArray(parsed.effective_effects)).toBe(true);
    expect(Array.isArray(parsed.inherited_effects)).toBe(true);
    expect(typeof parsed.propagation_chains).toBe("object");
    expect(Array.isArray(parsed.policies_in_scope)).toBe(true);
    expect(Array.isArray(parsed.suppressions)).toBe(true);
    expect(parsed.effective_effects).toContain("db.read");
    expect(parsed.propagation_chains["db.read"]).toBeDefined();
    expect(parsed.propagation_chains["db.read"].length).toBeGreaterThanOrEqual(2);
  });

  it("includes policy details in JSON output when policies apply", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(
      fixture.projectDir,
      fixture.uiNodeId,
      { json: true },
      deps,
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.policies_in_scope.length).toBeGreaterThanOrEqual(1);
    const policy = parsed.policies_in_scope[0];
    expect(policy.id).toBe("NO_IO_IN_UI");
    expect(policy.kind).toBe("forbid");
    expect(policy.effects).toContain("db.read");
    expect(policy.violation_count).toBeGreaterThanOrEqual(1);
  });

  it("passes cacheDir on the default run and omits it when --no-cache is set", async () => {
    const fixture = await buildPropagationFixture();
    const spy = vi.fn();
    const deps: ExplainEffectDeps = {
      extractCallGraph: async (opts) => {
        spy(opts);
        return fixture.callGraph;
      },
    };

    await runExplainEffect(fixture.projectDir, fixture.uiNodeId, {}, deps);
    await runExplainEffect(fixture.projectDir, fixture.uiNodeId, { noCache: true }, deps);

    expect(spy).toHaveBeenCalledTimes(2);
    const firstCall = spy.mock.calls[0]?.[0] as { cacheDir?: string };
    const secondCall = spy.mock.calls[1]?.[0] as { cacheDir?: string };
    expect(firstCall.cacheDir).toBe(resolve(fixture.projectDir, "contract/.cache"));
    expect(secondCall.cacheDir).toBeUndefined();
  });

  it("rejects non-typescript projects with a clear diagnostic", async () => {
    const projectDir = await createTempProject();
    const pythonConfig = { ...DEFAULT_CONFIG, targetLanguage: "python" };
    writeProjectFile(projectDir, STELE_CONFIG_FILE, `${JSON.stringify(pythonConfig, null, 2)}\n`);
    writeProjectFile(
      projectDir,
      "contract/main.stele",
      [
        "(metadata",
        '  (stele-version "0.1")',
        '  (project "explain-effect-non-ts"))',
        "",
      ].join("\n"),
    );

    const result = await runExplainEffect(projectDir, "anything", {});
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('typescript');

    const jsonResult = await runExplainEffect(projectDir, "anything", { json: true });
    expect(jsonResult.exitCode).toBe(2);
    const parsed = JSON.parse(jsonResult.output);
    expect(parsed.error).toBe("unsupported_language");
    expect(parsed.language).toBe("python");
  });

  it("renders signature and definition span for the inspected node", async () => {
    const fixture = await buildPropagationFixture();
    const deps = depsServingCachedGraph(fixture);

    const result = await runExplainEffect(fixture.projectDir, fixture.dbNodeId, {}, deps);

    expect(result.output).toContain("Defined:");
    expect(result.output).toContain("Signature:");
    expect(result.output).toContain("Kind:");
  });

  it("ensures the fixture call graph round-trips through the extractor", async () => {
    const fixture = await buildPropagationFixture();
    // Sanity: extracted graph still has the nodes we expect — guards the
    // rest of the suite against silent extractor regressions.
    expect(fixture.callGraph.nodes.some((n) => n.id === fixture.uiNodeId)).toBe(true);
    expect(fixture.callGraph.nodes.some((n) => n.id === fixture.dbNodeId)).toBe(true);
    // And the project directory is still on disk because we deliberately
    // kept it (see buildPropagationFixture).
    expect(existsSync(fixture.projectDir)).toBe(true);
  });
});
