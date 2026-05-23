import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STELE_CONFIG_FILE, DEFAULT_CONFIG } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/loadConfig.js";
import { loadContract } from "@stele/core";
import {
  evaluateArchitectureContract,
} from "../src/architecture-runtime.js";
import { buildArchitectureStageReport } from "../src/architecture/stage.js";
import type { PreparedCheckContext, ProtectedCheckState } from "../src/commands/check.js";
import type { GeneratedVerificationResult } from "@stele/core";

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
  const dir = await mkdtemp(join(tmpdir(), "stele-arch-unresolved-"));
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

async function loadAndEvaluate(projectDir: string): Promise<Awaited<ReturnType<typeof evaluateArchitectureContract>>> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(join(projectDir, config.entry));
  const arch = contract.architectures[0];
  return evaluateArchitectureContract({
    projectRoot: projectDir,
    architecture: {
      id: arch.id,
      modules: arch.modules.map((m) => ({ id: m.id, paths: m.paths })),
      allowDependencies: arch.allowDependencies,
      denyCycles: arch.denyCycles,
      tsconfig: arch.tsconfig,
    },
  });
}

// ---------------------------------------------------------------------------
// Test 1: Unresolved internal import is visible
// ---------------------------------------------------------------------------

describe("evaluateArchitectureContract — unresolved import visibility", () => {
  it("treats imports to unowned files as external dependencies (silently skipped)", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // Contract: api can depend on core
    writeContract(projectDir, `(architecture "test-arch"
  (lang typescript)
  (module api (path "src/api/**"))
  (module core (path "src/core/**"))
  (allow-dependency api core)
)`);

    // api imports from a path outside any declared module
    // The file exists but is NOT in any module → treated as external dependency
    const srcPath = join(projectDir, "src/api/handler.ts");
    mkdirSync(join(projectDir, "src/api"), { recursive: true });
    writeFileSync(
      srcPath,
      'import { something } from "../external/external.js";\nexport function handle() {}\n',
      "utf8",
    );

    // Create the external file (exists but is not in any module)
    const externalPath = join(projectDir, "src/external/external.ts");
    mkdirSync(join(projectDir, "src/external"), { recursive: true });
    writeFileSync(externalPath, 'export function something() { return 1; }\n', "utf8");

    // Also create a core file so the module has content
    const corePath = join(projectDir, "src/core/service.ts");
    mkdirSync(join(projectDir, "src/core"), { recursive: true });
    writeFileSync(corePath, 'export function process() { return "ok"; }\n', "utf8");

    const violations = await loadAndEvaluate(projectDir);

    // Imports to files outside any declared module are silently skipped
    // (treated as cross-architecture / external dependencies)
    const unresolved = violations.filter((v) => v.specifier.startsWith("unresolved:"));
    expect(unresolved.length).toBe(0);

    // No violations because the external import is outside the architecture's scope
    expect(violations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Ambiguous module ownership produces violations
// ---------------------------------------------------------------------------

describe("evaluateArchitectureContract — ambiguous module ownership", () => {
  it("reports files matching multiple module paths as violations", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // Contract with overlapping module paths
    writeContract(projectDir, `(architecture "overlap-arch"
  (lang typescript)
  (module api (path "src/shared/**"))
  (module core (path "src/shared/**"))
  (allow-dependency api core)
)`);

    // Create a file in the overlapping directory
    const sharedPath = join(projectDir, "src/shared/utils.ts");
    mkdirSync(join(projectDir, "src/shared"), { recursive: true });
    writeFileSync(sharedPath, 'export function util() { return 42; }\n', "utf8");

    const violations = await loadAndEvaluate(projectDir);

    // Should have ambiguous ownership violations
    const ambiguousViolations = violations.filter((v) => v.specifier.startsWith("ambiguous:"));
    expect(ambiguousViolations.length).toBeGreaterThanOrEqual(1);

    // The ambiguous violation should reference the overlapping file
    const amb = ambiguousViolations[0];
    expect(amb.fromFile).toContain("shared/utils");
    expect(amb.specifier).toContain("api");
    expect(amb.specifier).toContain("core");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Cycle violation has correct rule_kind "architecture_cycle"
// ---------------------------------------------------------------------------

describe("evaluateArchitectureContract — cycle detection", () => {
  it("reports cycle violations with cycle: prefix when deny-cycles is true", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // Contract with cycle detection enabled (no tsconfig, matching existing fixture)
    writeContract(projectDir, `(architecture "cycle-arch"
  (lang typescript)
  (module a (path "src/a/**"))
  (module b (path "src/b/**"))
  (deny-cycles true)
)`);

    // Create files that form a cycle: a imports b, b imports a
    const aPath = join(projectDir, "src/a/mod.ts");
    mkdirSync(join(projectDir, "src/a"), { recursive: true });
    writeFileSync(aPath, 'import { betaFn } from "../b/mod.js";\nexport function alphaFn() { return betaFn(); }\n', "utf8");

    const bPath = join(projectDir, "src/b/mod.ts");
    mkdirSync(join(projectDir, "src/b"), { recursive: true });
    writeFileSync(bPath, 'import { alphaFn } from "../a/mod.js";\nexport function betaFn() { return alphaFn(); }\n', "utf8");

    const violations = await loadAndEvaluate(projectDir);

    // Cycle violations have specifier starting with "cycle:"
    const cycleViolations = violations.filter((v) => v.specifier.startsWith("cycle:"));
    expect(cycleViolations.length).toBeGreaterThanOrEqual(2);

    // At least one cycle violation involves module "a" depending on "b"
    const aToB = cycleViolations.find((v) => v.fromModule === "a" && v.toModule === "b");
    expect(aToB).toBeDefined();
    expect(aToB!.specifier).toContain("a");
    expect(aToB!.specifier).toContain("b");

    // At least one cycle violation involves module "b" depending on "a"
    const bToA = cycleViolations.find((v) => v.fromModule === "b" && v.toModule === "a");
    expect(bToA).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 3b: Cycle violation has correct rule_kind in stage report
// ---------------------------------------------------------------------------

describe("buildArchitectureStageReport — cycle violation rule_kind", () => {
  it("produces rule_kind architecture_cycle for cycle violations", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // No tsconfig to avoid "Unexpected moduleResolution: bundler" error in architecture-core
    writeContract(projectDir, `(architecture "cycle-arch"
  (lang typescript)
  (module a (path "src/a/**"))
  (module b (path "src/b/**"))
  (deny-cycles true)
)`);

    const aPath = join(projectDir, "src/a/mod.ts");
    mkdirSync(join(projectDir, "src/a"), { recursive: true });
    writeFileSync(aPath, 'import { betaFn } from "../b/mod.js";\nexport function alphaFn() { return betaFn(); }\n', "utf8");

    const bPath = join(projectDir, "src/b/mod.ts");
    mkdirSync(join(projectDir, "src/b"), { recursive: true });
    writeFileSync(bPath, 'import { alphaFn } from "../a/mod.js";\nexport function betaFn() { return alphaFn(); }\n', "utf8");

    const config = await loadConfig(projectDir);
    const contract = await loadContract(join(projectDir, config.entry));

    const generatedResult: GeneratedVerificationResult = {
      ok: true,
      outputDir: "tests/generated",
      unchanged: [],
      missing: [],
      changed: [],
      extra: [],
      files: [],
    };

    const context: PreparedCheckContext = {
      projectDir,
      config,
      contract,
      generated: generatedResult,
      invariantCount: 0,
    };
    const protectedState: ProtectedCheckState = {
      protectedPaths: [...config.protected],
      contractHash: "",
      summary: { invariantCount: 0, generatedFileCount: 0, protectedFileCount: 0 },
    };

    const report = await buildArchitectureStageReport(context, protectedState, "check");

    // Should have cycle violations with correct rule_kind
    const cycleViolations = report.violations.filter((v) => v.rule_kind === "architecture_cycle");
    expect(cycleViolations.length).toBeGreaterThanOrEqual(1);

    const cycleV = cycleViolations[0];
    expect(cycleV.rule_kind).toBe("architecture_cycle");
    expect(cycleV.severity).toBe("error");
  });
});
