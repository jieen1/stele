import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STELE_CONFIG_FILE, DEFAULT_CONFIG } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { loadContract } from "@stele/core";
import { evaluateArchitectureRuntime } from "../src/architecture-runtime.js";

// ----------------------------------------------------------------
// Fixture paths
// ----------------------------------------------------------------

const FIXTURES_DIR = join(__dirname, "fixtures");
const VALID_DIR = join(FIXTURES_DIR, "typescript-architecture-valid");
const INVALID_EDGE_DIR = join(FIXTURES_DIR, "typescript-architecture-invalid-edge");
const CYCLE_DIR = join(FIXTURES_DIR, "typescript-architecture-cycle");

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-arch-fixture-"));
  tempDirs.push(dir);
  return dir;
}

function copyFixture(fixtureDir: string, destDir: string): void {
  const entries = readdirSync(fixtureDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(fixtureDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyFixture(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

async function setupFixture(fixtureDir: string): Promise<string> {
  const projectDir = await createTempDir();
  copyFixture(fixtureDir, projectDir);

  const configPath = join(projectDir, STELE_CONFIG_FILE);
  const config = JSON.stringify({ ...DEFAULT_CONFIG, entry: "contract/main.stele" }, null, 2) + "\n";
  writeFileSync(configPath, config, "utf8");

  return projectDir;
}

interface MinimalArch {
  id: string;
  modules: Array<{ id: string; paths: string[] }>;
  allowDependencies: Array<{ from: string; to: string[] }>;
  denyCycles: boolean;
}

function toMinimalArchitecture(
  arch: {
    id: string;
    modules: Array<{ id: string; paths: string[] }>;
    allowDependencies: Array<{ from: string; to: string[] }>;
    denyCycles: boolean;
  },
): MinimalArch {
  return {
    id: arch.id,
    modules: arch.modules.map((m) => ({ id: m.id, paths: m.paths })),
    allowDependencies: arch.allowDependencies,
    denyCycles: arch.denyCycles,
  };
}

async function loadAndEvaluate(projectDir: string): Promise<{
  contract: Awaited<ReturnType<typeof loadContract>>;
  arch: MinimalArch;
  result: Awaited<ReturnType<typeof evaluateArchitectureRuntime>>;
}> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(join(projectDir, config.entry));
  const arch = toMinimalArchitecture(contract.architectures[0]);
  const result = await evaluateArchitectureRuntime({
    projectRoot: projectDir,
    architecture: arch,
  });
  return { contract, arch, result };
}

// ----------------------------------------------------------------
// Valid fixture
// ----------------------------------------------------------------

describe("architecture fixture: typescript-architecture-valid", () => {
  it("passes architecture check — no violations", async () => {
    const projectDir = await setupFixture(VALID_DIR);
    const { result } = await loadAndEvaluate(projectDir);

    expect(result.dependencyViolations).toHaveLength(0);
    expect(result.cycleViolations).toHaveLength(0);
    expect(result.layerDirectionViolations).toHaveLength(0);
    expect(result.publicEntryViolations).toHaveLength(0);
  });
});

// ----------------------------------------------------------------
// Invalid-edge fixture
// ----------------------------------------------------------------

describe("architecture fixture: typescript-architecture-invalid-edge", () => {
  it("detects unauthorized dependency edge", async () => {
    const projectDir = await setupFixture(INVALID_EDGE_DIR);
    const { result } = await loadAndEvaluate(projectDir);

    expect(result.dependencyViolations).toHaveLength(1);

    const v = result.dependencyViolations[0];
    expect(v.fromModule).toBe("api");
    expect(v.toModule).toBe("infra");
    expect(v.fromFile).toContain("api");
    expect(v.specifier).toContain("infra");
    expect(v.line).toBeGreaterThan(0);
    expect(v.column).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------
// Cycle fixture
// ----------------------------------------------------------------

describe("architecture fixture: typescript-architecture-cycle", () => {
  it("detects circular dependency when deny-cycles is true", async () => {
    const projectDir = await setupFixture(CYCLE_DIR);
    const { contract, result } = await loadAndEvaluate(projectDir);

    expect(contract.architectures).toHaveLength(1);
    expect(contract.architectures[0].denyCycles).toBe(true);

    // The structured runtime result reports cycles as cycleViolations entries
    // with the full module list, not as flattened pseudo-edges.
    expect(result.cycleViolations.length).toBeGreaterThanOrEqual(1);

    const cycle = result.cycleViolations[0];
    expect(cycle.modules).toContain("a");
    expect(cycle.modules).toContain("b");

    // Cycle violations reference actual source files
    expect(cycle.edgeFiles.length).toBeGreaterThan(0);
    expect(cycle.edgeFiles[0]).toBeTruthy();
  });
});

// ----------------------------------------------------------------
// End-to-end: contract pipeline
// ----------------------------------------------------------------

describe("architecture fixture: end-to-end contract pipeline", () => {
  it("loads contract, extracts architecture, and evaluates all three fixtures correctly", async () => {
    // Valid: zero violations
    const validDir = await setupFixture(VALID_DIR);
    const validRun = await loadAndEvaluate(validDir);
    expect(validRun.result.dependencyViolations).toHaveLength(0);
    expect(validRun.result.cycleViolations).toHaveLength(0);

    // Invalid-edge: has violations
    const invalidDir = await setupFixture(INVALID_EDGE_DIR);
    const invalidRun = await loadAndEvaluate(invalidDir);
    expect(invalidRun.result.dependencyViolations.length).toBeGreaterThan(0);

    // Cycle: detected when deny-cycles enabled
    const cycleDir = await setupFixture(CYCLE_DIR);
    const cycleRun = await loadAndEvaluate(cycleDir);
    expect(cycleRun.contract.architectures[0].denyCycles).toBe(true);
    expect(cycleRun.result.cycleViolations.length).toBeGreaterThanOrEqual(1);
  });
});
