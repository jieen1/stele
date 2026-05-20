import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { STELE_CONFIG_FILE, DEFAULT_CONFIG } from "../src/config/defaults.js";
import { writeManifest, type GenerationManifest } from "../src/design-generator/manifest.js";
import { hashString } from "../src/design-profile/hash.js";
import type { DesignProfile } from "../src/design-profile/types.js";
import { runDesignGenerate } from "../src/commands/design/generate.js";
import { validateOwnership } from "../src/design-generator/ownership.js";

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
  const dir = await mkdtemp(join(tmpdir(), "stele-ddd-import-drift-"));
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

function writeProfile(projectDir: string, profile: DesignProfile): void {
  const path = join(projectDir, "contract/design/profile.yaml");
  mkdirSync(join(projectDir, "contract/design"), { recursive: true });
  writeFileSync(path, yaml.dump(profile), "utf8");
}

function minimalProfile(): DesignProfile {
  return {
    schema_version: 1,
    kind: "stele-design-profile",
    profile_id: "test-profile",
    created_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-19T00:00:00.000Z",
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: [],
      tsconfig: "tsconfig.json",
    },
    ddd: {
      bounded_context_strategy: "by_business_function",
      contexts: [
        {
          id: "billing",
          name: "Billing",
          subdomain_type: "core",
          root: "src/billing",
          layers: {
            domain: "src/billing/domain/**/*.ts",
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: Import is added to contract/main.stele
// ---------------------------------------------------------------------------

describe("runDesignGenerate — ensures import in main.stele", () => {
  it("adds import line to contract/main.stele when file exists but lacks the import", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // Contract has an invariant but NO import of the generated file
    writeContract(projectDir, `(invariant "no-mutation"
  (description "No direct mutation of state")
  (category "safety")
  (severity "critical")
  (scenario "no-mutation-check")
)`);

    writeProfile(projectDir, minimalProfile());

    // Capture stdout to avoid polluting test output
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const stdoutLines: string[] = [];
    process.stdout.write = ((chunk: string) => {
      stdoutLines.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    await runDesignGenerate({}, projectDir);

    // Restore stdout
    process.stdout.write = originalStdoutWrite;

    // Verify the import was added
    const mainContent = readFileSync(join(projectDir, "contract/main.stele"), "utf8");
    expect(mainContent).toContain('(import "contract/generated/ddd-typedriven.stele")');

    // The original invariant should still be there (import is appended, not replacing)
    expect(mainContent).toContain("(invariant \"no-mutation\"");
  });

  it("creates contract/main.stele if it does not exist", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // No main.stele at all
    writeProfile(projectDir, minimalProfile());

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await runDesignGenerate({}, projectDir);

    process.stdout.write = originalStdoutWrite;

    const mainPath = join(projectDir, "contract/main.stele");
    const mainContent = readFileSync(mainPath, "utf8");
    expect(mainContent).toContain('(import "contract/generated/ddd-typedriven.stele")');
  });

  it("does not duplicate the import if it already exists", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);

    // Contract already has the import
    writeContract(projectDir, `(import "contract/generated/ddd-typedriven.stele")

(invariant "existing"
  (description "existing invariant")
  (category "test")
  (severity "critical")
)`);

    writeProfile(projectDir, minimalProfile());

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;

    await runDesignGenerate({}, projectDir);

    process.stdout.write = originalStdoutWrite;

    const mainContent = readFileSync(join(projectDir, "contract/main.stele"), "utf8");
    const importCount = (mainContent.match(/\(import "contract\/generated\/ddd-typedriven\.stele"\)/g) || []).length;
    expect(importCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Manual generated drift is detected by ownership validation
// ---------------------------------------------------------------------------

describe("validateOwnership — manual drift detection", () => {
  it("detects unexpected edits when a generated file is manually modified", async () => {
    const projectDir = await createTempDir();

    // Create a manifest with a known generated file hash
    const originalContent = "(architecture \"ddd-billing\" (lang typescript) (module billing-domain (path \"src/billing/domain\")))\n";
    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: hashString("test-profile-content"),
      generatedAt: "2026-05-19T00:00:00.000Z",
      generatedRules: [
        {
          ruleId: "architecture.ddd-billing",
          ruleKind: "architecture",
          origin: "context:billing",
          fileHash: hashString(originalContent),
          cdl: originalContent,
        },
      ],
      generatedFiles: [
        {
          path: "contract/generated/ddd-typedriven.stele",
          hash: hashString(originalContent),
        },
      ],
    };
    writeManifest(projectDir, manifest);

    // Write the generated file with the original content
    const generatedPath = join(projectDir, "contract/generated/ddd-typedriven.stele");
    mkdirSync(join(projectDir, "contract/generated"), { recursive: true });
    writeFileSync(generatedPath, originalContent, "utf8");

    // Ownership should be clean initially
    let result = validateOwnership(projectDir);
    expect(result.owned).toBe(true);
    expect(result.unexpectedEdits).toHaveLength(0);

    // Now simulate a manual edit (drift)
    const driftedContent = originalContent + '\n; manually edited\n';
    writeFileSync(generatedPath, driftedContent, "utf8");

    // Ownership should detect the drift
    result = validateOwnership(projectDir);
    expect(result.owned).toBe(false);
    expect(result.unexpectedEdits).toContain("ddd-typedriven.stele");
  });

  it("reports orphan files when extra files exist in generated directory", async () => {
    const projectDir = await createTempDir();

    // Manifest knows about one file
    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "abc123",
      generatedAt: "2026-05-19T00:00:00.000Z",
      generatedRules: [],
      generatedFiles: [
        {
          path: "contract/generated/ddd-typedriven.stele",
          hash: hashString("original content"),
        },
      ],
    };
    writeManifest(projectDir, manifest);

    const generatedDir = join(projectDir, "contract/generated");
    mkdirSync(generatedDir, { recursive: true });

    // Write the known file
    writeFileSync(join(generatedDir, "ddd-typedriven.stele"), "original content", "utf8");
    // Write an orphan file
    writeFileSync(join(generatedDir, "manual-addition.stele"), "manual content", "utf8");

    const result = validateOwnership(projectDir);
    expect(result.orphanCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3: verifyManifestIntegrity detects CDL hash mismatch
// ---------------------------------------------------------------------------

describe("verifyManifestIntegrity — CDL hash drift detection", () => {
  it("detects drift when the stored fileHash no longer matches the CDL content", async () => {
    const projectDir = await createTempDir();

    // Create a manifest where the fileHash does NOT match the actual CDL hash
    const cdl = "(architecture \"ddd-billing\" (lang typescript) (module billing-domain (path \"src/billing/domain\")))";
    const wrongHash = hashString("some completely different content");

    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: hashString("profile content"),
      generatedAt: "2026-05-19T00:00:00.000Z",
      generatedRules: [
        {
          ruleId: "architecture.ddd-billing",
          ruleKind: "architecture",
          origin: "context:billing",
          fileHash: wrongHash, // Intentionally wrong hash
          cdl: cdl,
        },
        {
          ruleId: "core-node.billing-invoice-aggregate",
          ruleKind: "core-node",
          origin: "aggregate:invoice",
          fileHash: hashString("(core-node \"billing-invoice-aggregate\" (target \"src/billing/Invoice.ts\"))"), // Correct hash
          cdl: "(core-node \"billing-invoice-aggregate\" (target \"src/billing/Invoice.ts\"))",
        },
      ],
    };
    writeManifest(projectDir, manifest);

    const result = await import("../src/design-generator/manifest.js").then(async (mod) =>
      mod.verifyManifestIntegrity(projectDir),
    );

    // Should detect drift only for the rule with wrong hash
    expect(result.valid).toBe(false);
    expect(result.drifts).toContain("architecture.ddd-billing");
    expect(result.drifts).not.toContain("core-node.billing-invoice-aggregate");
    expect(result.drifts).toHaveLength(1);
  });

  it("returns valid when all CDL hashes match their stored fileHash", async () => {
    const projectDir = await createTempDir();

    const archCdl = "(architecture \"ddd-billing\" (lang typescript))";
    const cnCdl = "(core-node \"billing-invoice-aggregate\" (target \"src/billing/Invoice.ts\"))";

    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: hashString("profile content"),
      generatedAt: "2026-05-19T00:00:00.000Z",
      generatedRules: [
        {
          ruleId: "architecture.ddd-billing",
          ruleKind: "architecture",
          origin: "context:billing",
          fileHash: hashString(archCdl), // Correct hash
          cdl: archCdl,
        },
        {
          ruleId: "core-node.billing-invoice-aggregate",
          ruleKind: "core-node",
          origin: "aggregate:invoice",
          fileHash: hashString(cnCdl), // Correct hash
          cdl: cnCdl,
        },
      ],
    };
    writeManifest(projectDir, manifest);

    const result = await import("../src/design-generator/manifest.js").then(async (mod) =>
      mod.verifyManifestIntegrity(projectDir),
    );

    expect(result.valid).toBe(true);
    expect(result.drifts).toHaveLength(0);
  });

  it("returns invalid with 'manifest-not-found' drift when no manifest exists", async () => {
    const projectDir = await createTempDir();
    // No manifest written

    const result = await import("../src/design-generator/manifest.js").then(async (mod) =>
      mod.verifyManifestIntegrity(projectDir),
    );

    expect(result.valid).toBe(false);
    expect(result.drifts).toContain("manifest-not-found");
  });
});

// ---------------------------------------------------------------------------
// Scenario: Generator/template hash drift is detectable
// ---------------------------------------------------------------------------

describe("buildManifest — generator provenance tracking", () => {
  it("embeds generator identity with version and git sha in manifest", async () => {
    const projectDir = await createTempDir();

    const archCdl = "(architecture \"ddd-billing\" (lang typescript))";
    const manifest = await import("../src/design-generator/manifest.js").then(async (mod) =>
      mod.buildManifest({
        profileHash: hashString("profile content"),
        generator: {
          package: "@stele/cli",
          version: "0.1.0",
          git_sha: "abc1234",
        },
        templates: ["ddd-typedriven"],
        architectures: [archCdl],
        coreNodes: [],
      }),
    );

    writeManifest(projectDir, manifest);

    expect(manifest.generator).not.toBeUndefined();
    expect(manifest.generator!.package).toBe("@stele/cli");
    expect(manifest.generator!.version).toBe("0.1.0");
    expect(manifest.generator!.git_sha).toBe("abc1234");
    expect(manifest.templates).toContain("ddd-typedriven");
  });

  it("detects generator hash drift when manifest is tampered", async () => {
    const projectDir = await createTempDir();

    // Write a manifest with a correct rule, then tamper with the fileHash
    const originalCdl = "(architecture \"ddd-billing\" (lang typescript) (module billing-domain (path \"src/billing/domain\")))";
    const tamperedCdl = "(architecture \"ddd-billing\" (lang typescript) (module billing-domain (path \"src/billing/domain-CHANGED\")))";

    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: hashString("profile content"),
      generatedAt: "2026-05-19T00:00:00.000Z",
      generatedRules: [
        {
          ruleId: "architecture.ddd-billing",
          ruleKind: "architecture",
          origin: "context:billing",
          fileHash: hashString(originalCdl), // Hash of ORIGINAL content
          cdl: tamperedCdl, // But CDL was tampered
        },
      ],
    };
    writeManifest(projectDir, manifest);

    const { verifyManifestIntegrity } = await import("../src/design-generator/manifest.js");
    const result = verifyManifestIntegrity(projectDir);

    // The CDL hash (hashString(tamperedCdl)) does NOT match the stored fileHash (hashString(originalCdl))
    expect(result.valid).toBe(false);
    expect(result.drifts).toContain("architecture.ddd-billing");
  });
});
