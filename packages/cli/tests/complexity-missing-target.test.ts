import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STELE_CONFIG_FILE, DEFAULT_CONFIG } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { loadContract } from "@stele/core";
import { evaluateCoreNodes } from "../src/complexity/evaluate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-complexity-missing-"));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(projectDir: string): void {
  const configPath = join(projectDir, STELE_CONFIG_FILE);
  const config = JSON.stringify({ ...DEFAULT_CONFIG, entry: "contract/main.stele" }, null, 2) + "\n";
  writeFileSync(configPath, config, "utf8");
}

function writeContract(projectDir: string, content: string): void {
  const path = join(projectDir, "contract/main.stele");
  mkdirSync(join(projectDir, "contract"), { recursive: true });
  writeFileSync(path, content, "utf8");
}

// ---------------------------------------------------------------------------
// Test: Missing target fails — configuration violation
// ---------------------------------------------------------------------------

describe("evaluateCoreNodes — missing target", () => {
  it("reports configuration violation when target file does not exist", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // Contract references a file that doesn't exist
    writeContract(projectDir, `(core-node "missing-file"
  (lang typescript)
  (target "src/nonexistent/Service.ts::Service")
  (role business-core-service)
  (metric sloc (ideal 100) (max 200))
)`);

    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    expect(contract.coreNodes).toHaveLength(1);
    expect(contract.coreNodes[0].target).toBe("src/nonexistent/Service.ts::Service");

    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);
    expect(results).toHaveLength(1);

    const result = results[0];

    // Should have a configuration violation for missing target
    expect(result.violations).toHaveLength(1);
    const violation = result.violations[0];
    expect(violation.nodeId).toBe("missing-file");
    expect(violation.metric).toBe("missing-target");
    expect(violation.isConfigurationViolation).toBe(true);
    expect(violation.target).toBe("src/nonexistent/Service.ts::Service");
  });

  it("reports configuration violation when target class does not exist in file", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    writeContract(projectDir, `(core-node "missing-class"
  (lang typescript)
  (target "src/existing/Service.ts::NonExistentClass")
  (role business-core-service)
  (metric sloc (ideal 100) (max 200))
)`);

    // Create the file but with a different class name
    const srcPath = join(projectDir, "src/existing/Service.ts");
    mkdirSync(join(projectDir, "src/existing"), { recursive: true });
    writeFileSync(srcPath, 'export class RealService {\n  constructor() {}\n}\n', "utf8");

    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);
    expect(results).toHaveLength(1);

    const result = results[0];

    // Should have a configuration violation for missing class
    expect(result.violations).toHaveLength(1);
    const violation = result.violations[0];
    expect(violation.nodeId).toBe("missing-class");
    expect(violation.metric).toBe("missing-target");
    expect(violation.isConfigurationViolation).toBe(true);
  });

  it("returns no violations when target file and class both exist", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    writeContract(projectDir, `(core-node "valid-target"
  (lang typescript)
  (target "src/valid/Service.ts::Service")
  (role business-core-service)
  (metric sloc (ideal 100) (max 200))
)`);

    // Create the file with the correct class
    const srcPath = join(projectDir, "src/valid/Service.ts");
    mkdirSync(join(projectDir, "src/valid"), { recursive: true });
    writeFileSync(srcPath, 'export class Service {\n  constructor() {}\n}\n', "utf8");

    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);
    expect(results).toHaveLength(1);

    const result = results[0];

    // Should have no violations (SLOC is well below max)
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: public-method-count is vacuous on non-class targets — guard fails closed
// ---------------------------------------------------------------------------

describe("evaluateCoreNodes — public-method-count guard", () => {
  it("reports a configuration violation when public-method-count targets a free function", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    writeContract(projectDir, `(core-node "fn-with-method-metric"
  (lang typescript)
  (target "src/fn.ts::doThing")
  (role business-core-service)
  (metric sloc (ideal 50) (max 100))
  (metric public-method-count (ideal 4) (max 10))
)`);

    const srcPath = join(projectDir, "src/fn.ts");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(srcPath, "export function doThing(): number {\n  return 1;\n}\n", "utf8");

    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);
    expect(results).toHaveLength(1);

    const violation = results[0].violations[0];
    expect(results[0].violations).toHaveLength(1);
    expect(violation.metric).toBe("public-method-count");
    expect(violation.isConfigurationViolation).toBe(true);
    expect(violation.nodeId).toBe("fn-with-method-metric");
  });

  it("does NOT fire the guard when public-method-count targets a real class", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    writeContract(projectDir, `(core-node "class-with-method-metric"
  (lang typescript)
  (target "src/svc.ts::Svc")
  (role business-core-service)
  (metric public-method-count (ideal 4) (max 10))
)`);

    const srcPath = join(projectDir, "src/svc.ts");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(srcPath, "export class Svc {\n  a(): void {}\n  b(): void {}\n}\n", "utf8");

    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    const results = await evaluateCoreNodes(projectDir, contract.coreNodes);
    expect(results).toHaveLength(1);
    // Class has 2 public methods, under max 10, and the guard does not apply to
    // class targets — so no violation at all.
    expect(results[0].violations).toHaveLength(0);
  });
});
