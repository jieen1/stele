import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STELE_CONFIG_FILE, DEFAULT_CONFIG } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { loadContract } from "@stele/core";
import { evaluateCoreNodes } from "../src/complexity/evaluate.js";

// ----------------------------------------------------------------
// Fixture paths
// ----------------------------------------------------------------

const FIXTURES_DIR = join(__dirname, "fixtures");
const IDEAL_WARNING_DIR = join(FIXTURES_DIR, "typescript-core-node-ideal-warning");
const MAX_FAIL_DIR = join(FIXTURES_DIR, "typescript-core-node-max-fail");

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-complexity-fixture-"));
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

  // Write stele.config.json so the CLI can find the contract
  const configPath = join(projectDir, STELE_CONFIG_FILE);
  const config = JSON.stringify({ ...DEFAULT_CONFIG, entry: "contract/main.stele" }, null, 2) + "\n";
  writeFileSync(configPath, config, "utf8");

  return projectDir;
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe("complexity fixture: typescript-core-node-ideal-warning", () => {
  it("SLOC above ideal but below max produces notice, no violation", async () => {
    const projectDir = await setupFixture(IDEAL_WARNING_DIR);
    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    expect(contract.coreNodes).toHaveLength(1);

    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);
    expect(results).toHaveLength(1);

    const result = results[0];

    // No violations (SLOC is below max)
    expect(result.violations).toHaveLength(0);

    // Notice for SLOC exceeding ideal
    expect(result.notices).toHaveLength(1);

    const notice = result.notices[0];
    expect(notice.nodeId).toBe("my-service");
    expect(notice.metric).toBe("sloc");
    expect(notice.value).toBeGreaterThan(notice.ideal);
    expect(notice.value).toBeLessThanOrEqual(notice.max);

    const slocMetric = result.measurement.metrics.find((m) => m.name === "sloc");
    expect(slocMetric).toBeDefined();
    expect(slocMetric!.status).toBe("above-ideal");
  });
});

describe("complexity fixture: typescript-core-node-max-fail", () => {
  it("SLOC exceeding max produces violation", async () => {
    const projectDir = await setupFixture(MAX_FAIL_DIR);
    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    expect(contract.coreNodes).toHaveLength(1);

    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);
    expect(results).toHaveLength(1);

    const result = results[0];

    // Violation for SLOC exceeding max
    expect(result.violations).toHaveLength(1);

    const violation = result.violations[0];
    expect(violation.nodeId).toBe("my-service");
    expect(violation.metric).toBe("sloc");
    expect(violation.value).toBeGreaterThan(violation.max);

    const slocMetric = result.measurement.metrics.find((m) => m.name === "sloc");
    expect(slocMetric).toBeDefined();
    expect(slocMetric!.status).toBe("over-max");
  });
});

describe("complexity fixture: end-to-end contract pipeline", () => {
  it("loads contract, evaluates core nodes, and correctly classifies both fixtures", async () => {
    // Ideal-warning: notice only
    const idealProjectDir = await setupFixture(IDEAL_WARNING_DIR);
    const idealConfig = await loadConfig(idealProjectDir);
    const idealContract = await loadContract(join(idealProjectDir, idealConfig.entry));
    const idealResults = await evaluateCoreNodes(idealProjectDir, idealContract.coreNodes);

    const idealHasViolations = idealResults.some((r) => r.violations.length > 0);
    const idealHasNotices = idealResults.some((r) => r.notices.length > 0);

    expect(idealHasViolations).toBe(false);
    expect(idealHasNotices).toBe(true);

    // Max-fail: violation
    const maxProjectDir = await setupFixture(MAX_FAIL_DIR);
    const maxConfig = await loadConfig(maxProjectDir);
    const maxContract = await loadContract(join(maxProjectDir, maxConfig.entry));
    const maxResults = await evaluateCoreNodes(maxProjectDir, maxContract.coreNodes);

    const maxHasViolations = maxResults.some((r) => r.violations.length > 0);
    expect(maxHasViolations).toBe(true);

    // Verify the violation details
    const maxViolation = maxResults[0].violations[0];
    expect(maxViolation.metric).toBe("sloc");
    expect(maxViolation.value).toBeGreaterThan(maxViolation.max);
  });
});

describe("complexity fixture: measurement values", () => {
  it("ideal-warning fixture has SLOC in (ideal, max] range", async () => {
    const projectDir = await setupFixture(IDEAL_WARNING_DIR);
    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));
    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);

    const sloc = results[0].measurement.metrics.find((m) => m.name === "sloc")!.value;
    const ideal = results[0].measurement.metrics.find((m) => m.name === "sloc")!.ideal;
    const max = results[0].measurement.metrics.find((m) => m.name === "sloc")!.max;

    expect(sloc).toBeGreaterThan(ideal);
    expect(sloc).toBeLessThanOrEqual(max);
  });

  it("max-fail fixture has SLOC greater than max", async () => {
    const projectDir = await setupFixture(MAX_FAIL_DIR);
    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));
    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);

    const sloc = results[0].measurement.metrics.find((m) => m.name === "sloc")!.value;
    const max = results[0].measurement.metrics.find((m) => m.name === "sloc")!.max;

    expect(sloc).toBeGreaterThan(max);
  });
});
