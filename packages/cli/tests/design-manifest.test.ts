import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

import type { DesignProfile } from "../src/design-profile/types.js";
import { hashFile, hashString } from "../src/design-profile/hash.js";
import { generateFromProfile } from "../src/design-generator/ddd.js";
import {
  asRawProfile,
  markProfileValidated,
  hashValidatedProfile,
  type TypedDesignProfile,
} from "../src/design-profile/lifecycle.js";
import {
  writeManifest,
  readManifest,
  verifyManifestIntegrity,
  buildManifest,
  type GenerationManifest,
  type GeneratedRuleEntry,
} from "../src/design-generator/manifest.js";
import { validateOwnership } from "../src/design-generator/ownership.js";

const brand = (p: DesignProfile): TypedDesignProfile<"Hashed"> =>
  hashValidatedProfile(markProfileValidated(asRawProfile(p)), hashString(JSON.stringify(p)))
    .profile;

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
  const dir = await mkdtemp(join(tmpdir(), "stele-manifest-"));
  tempDirs.push(dir);
  return dir;
}

async function writeProfile(dir: string, profile: DesignProfile): Promise<string> {
  const filePath = join(dir, "contract", "design", "profile.yaml");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, yaml.dump(profile), "utf8");
  return filePath;
}

async function writeGeneratedFile(
  dir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const fullPath = join(dir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  return fullPath;
}

function makeTestManifest(): GenerationManifest {
  const cdl = '(architecture "ddd-billing"\n  (lang typescript)\n)';
  return {
    schemaVersion: "1",
    profileHash: "abc123",
    profilePath: "contract/design/profile.yaml",
    generator: {
      package: "@stele/cli",
      version: "0.1.0",
      git_sha: "abc1234",
    },
    templates: ["ddd-typedriven"],
    generatedRules: [
      {
        ruleId: "architecture.ddd-billing",
        ruleKind: "architecture",
        origin: "context:billing",
        origins: [{ type: "context", context_id: "billing", context_name: "Billing" }],
        fileHash: hashString(cdl),
        cdl,
      },
    ],
    generatedAt: new Date().toISOString(),
    generatedFiles: [
      {
        path: "contract/generated/ddd-typedriven.stele",
        hash: hashString(cdl),
      },
    ],
  };
}

function minimalProfile(): DesignProfile {
  return {
    schema_version: 1,
    kind: "stele-design-profile",
    profile_id: "test",
    created_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-19T00:00:00.000Z",
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Write manifest → read it back → matches
// ---------------------------------------------------------------------------

describe("writeManifest → readManifest round-trip", () => {
  it("writes and reads back a manifest correctly", async () => {
    const dir = await createTempDir();
    const manifest = makeTestManifest();

    writeManifest(dir, manifest);
    const read = readManifest(dir);

    expect(read).not.toBeNull();
    expect(read!.schemaVersion).toBe("1");
    expect(read!.profileHash).toBe("abc123");
    expect(read!.generatedRules).toHaveLength(1);
    expect(read!.generatedRules[0].ruleId).toBe("architecture.ddd-billing");
    expect(read!.generatedFiles).toHaveLength(1);
    expect(read!.generatedFiles![0].path).toBe("contract/generated/ddd-typedriven.stele");
  });

  it("readManifest returns null when file does not exist", () => {
    const dir = join(tmpdir(), "stele-nonexistent-" + Date.now());
    expect(readManifest(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manifest integrity: matching hashes → valid
// ---------------------------------------------------------------------------

describe("verifyManifestIntegrity — matching hashes", () => {
  it("returns valid when all rule hashes match", async () => {
    const dir = await createTempDir();
    const manifest = makeTestManifest();

    writeManifest(dir, manifest);
    const result = verifyManifestIntegrity(dir);

    expect(result.valid).toBe(true);
    expect(result.drifts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manifest integrity: drifted hash → detected
// ---------------------------------------------------------------------------

describe("verifyManifestIntegrity — drifted hashes", () => {
  it("detects drift when a rule hash does not match its CDL", async () => {
    const dir = await createTempDir();
    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "abc123",
      generatedRules: [
        {
          ruleId: "architecture.ddd-billing",
          ruleKind: "architecture",
          origin: "context:billing",
          fileHash: "wrong-hash-that-does-not-match",
          cdl: "(architecture \"ddd-billing\")",
        },
      ],
      generatedAt: new Date().toISOString(),
    };

    writeManifest(dir, manifest);
    const result = verifyManifestIntegrity(dir);

    expect(result.valid).toBe(false);
    expect(result.drifts).toContain("architecture.ddd-billing");
  });

  it("detects multiple drifted rules", async () => {
    const dir = await createTempDir();
    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "abc123",
      generatedRules: [
        {
          ruleId: "rule-a",
          ruleKind: "architecture",
          origin: "context:a",
          fileHash: "bad-hash",
          cdl: "(architecture \"ddd-a\")",
        },
        {
          ruleId: "rule-b",
          ruleKind: "core-node",
          origin: "aggregate:b",
          fileHash: "also-bad",
          cdl: "(core-node \"b\")",
        },
      ],
      generatedAt: new Date().toISOString(),
    };

    writeManifest(dir, manifest);
    const result = verifyManifestIntegrity(dir);

    expect(result.valid).toBe(false);
    expect(result.drifts).toContain("rule-a");
    expect(result.drifts).toContain("rule-b");
  });
});

// ---------------------------------------------------------------------------
// Ownership: all files accounted for → owned=true
// ---------------------------------------------------------------------------

describe("validateOwnership — clean state", () => {
  it("returns owned=true when manifest matches on-disk files", async () => {
    const dir = await createTempDir();
    const cdl = '(architecture "ddd-billing"\n  (lang typescript)\n)';
    const manifest = makeTestManifest();

    // Write manifest
    writeManifest(dir, manifest);

    // Write the generated file with matching content
    await writeGeneratedFile(dir, "contract/generated/ddd-typedriven.stele", cdl);

    const result = validateOwnership(dir);
    expect(result.owned).toBe(true);
    expect(result.orphanCount).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.unexpectedEdits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ownership: orphan file → owned=false
// ---------------------------------------------------------------------------

describe("validateOwnership — orphan files", () => {
  it("detects orphan file not in manifest", async () => {
    const dir = await createTempDir();
    const cdl = '(architecture "ddd-billing"\n  (lang typescript)\n)';
    const manifest = makeTestManifest();

    writeManifest(dir, manifest);
    // Write the expected file
    await writeGeneratedFile(dir, "contract/generated/ddd-typedriven.stele", cdl);
    // Write an orphan file not in the manifest
    await writeGeneratedFile(dir, "contract/generated/hand-edited.stele", "(some junk)");

    const result = validateOwnership(dir);
    expect(result.owned).toBe(false);
    expect(result.orphanCount).toBe(1);
  });

  it("detects orphans when no manifest exists", async () => {
    const dir = await createTempDir();
    // Write a generated file but no manifest
    await writeGeneratedFile(dir, "contract/generated/orphan.stele", "(junk)");

    const result = validateOwnership(dir);
    expect(result.owned).toBe(false);
    expect(result.orphanCount).toBe(1);
    expect(result.missingCount).toBe(0);
  });

  it("returns owned=true when no generated files and no manifest", async () => {
    const dir = await createTempDir();
    const result = validateOwnership(dir);
    expect(result.owned).toBe(true);
    expect(result.orphanCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ownership: missing file → owned=false
// ---------------------------------------------------------------------------

describe("validateOwnership — missing files", () => {
  it("detects missing file when manifest references a file that does not exist", async () => {
    const dir = await createTempDir();
    const manifest = makeTestManifest();

    // Write manifest but NOT the generated file
    writeManifest(dir, manifest);

    const result = validateOwnership(dir);
    expect(result.owned).toBe(false);
    expect(result.missingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ownership: unexpected edits → detected
// ---------------------------------------------------------------------------

describe("validateOwnership — unexpected edits", () => {
  it("detects when file content has been modified", async () => {
    const dir = await createTempDir();
    const cdl = '(architecture "ddd-billing"\n  (lang typescript)\n)';
    const manifest = makeTestManifest();

    writeManifest(dir, manifest);
    // Write the file with DIFFERENT content
    const tamperedContent = "(architecture \"ddd-billing\"\n  (lang python)\n)";
    await writeGeneratedFile(dir, "contract/generated/ddd-typedriven.stele", tamperedContent);

    const result = validateOwnership(dir);
    expect(result.owned).toBe(false);
    expect(result.unexpectedEdits.length).toBe(1);
    expect(result.unexpectedEdits[0]).toContain("ddd-typedriven.stele");
  });
});

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

describe("buildManifest", () => {
  it("builds a manifest from architectures and core-nodes", () => {
    const arch = '(architecture "ddd-billing"\n  (lang typescript)\n)';
    const cn = '(core-node "billing-invoice-aggregate"\n  (lang typescript)\n)';

    const manifest = buildManifest({
      profileHash: "profile-hash",
      architectures: [arch],
      coreNodes: [cn],
      outputFiles: [
        { path: "contract/generated/ddd-typedriven.stele", content: arch + "\n\n" + cn },
      ],
    });

    expect(manifest.schemaVersion).toBe("1");
    expect(manifest.profileHash).toBe("profile-hash");
    expect(manifest.generatedRules).toHaveLength(2);
    expect(manifest.generatedRules[0].ruleKind).toBe("architecture");
    expect(manifest.generatedRules[1].ruleKind).toBe("core-node");
    expect(manifest.generatedFiles).toHaveLength(1);
    expect(manifest.generatedFiles![0].path).toBe("contract/generated/ddd-typedriven.stele");
  });

  it("populates generator, profilePath, and templates when provided", () => {
    const arch = '(architecture "ddd-billing"\n  (lang typescript)\n)';

    const manifest = buildManifest({
      profileHash: "profile-hash",
      profilePath: "contract/design/profile.yaml",
      generator: {
        package: "@stele/cli",
        version: "0.1.0",
        git_sha: "abc1234",
      },
      templates: ["ddd-typedriven"],
      architectures: [arch],
      coreNodes: [],
    });

    expect(manifest.profilePath).toBe("contract/design/profile.yaml");
    expect(manifest.generator).toEqual({
      package: "@stele/cli",
      version: "0.1.0",
      git_sha: "abc1234",
    });
    expect(manifest.templates).toEqual(["ddd-typedriven"]);
  });

  it("populates structured origins for architecture rules", () => {
    const arch = '(architecture "ddd-billing"\n  (lang typescript)\n)';

    const manifest = buildManifest({
      profileHash: "hash",
      architectures: [arch],
      coreNodes: [],
    });

    const rule = manifest.generatedRules[0];
    expect(rule.origins).toHaveLength(1);
    expect(rule.origins![0]).toEqual({
      type: "context",
      context_id: "billing",
      context_name: "Billing",
    });
  });

  it("populates structured origins for core-node rules", () => {
    const cn = '(core-node "billing-invoice-aggregate"\n  (lang typescript)\n)';

    const manifest = buildManifest({
      profileHash: "hash",
      architectures: [],
      coreNodes: [cn],
    });

    const rule = manifest.generatedRules[0];
    expect(rule.origins).toHaveLength(1);
    expect(rule.origins![0]).toEqual({
      type: "aggregate",
      aggregate_id: "invoice",
    });
  });

  it("populates decision origin for ddd-context-map architecture", () => {
    const arch = '(architecture "ddd-context-map"\n  (lang typescript)\n)';

    const manifest = buildManifest({
      profileHash: "hash",
      architectures: [arch],
      coreNodes: [],
    });

    const rule = manifest.generatedRules[0];
    expect(rule.origins).toHaveLength(1);
    expect(rule.origins![0]).toEqual({
      type: "decision",
      decision_id: "q1-bounded-contexts",
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: generate from profile → write manifest → verify
// ---------------------------------------------------------------------------

describe("end-to-end: generate → manifest → verify", () => {
  it("generates from profile, writes manifest, verifies integrity", async () => {
    const dir = await createTempDir();

    const profile: DesignProfile = {
      schema_version: 1,
      kind: "stele-design-profile",
      profile_id: "ddd-typedriven",
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
              infrastructure: "src/billing/infrastructure/**/*.ts",
            },
            aggregate_roots: [
              {
                id: "invoice",
                class: "Invoice",
                target: "src/billing/domain/Invoice.ts::Invoice",
                metrics: { sloc: { ideal: 200, max: 300 } },
              },
            ],
          },
        ],
      },
    };

    // Generate
    const result = generateFromProfile(brand(profile));

    // Compute profile hash
    const profilePath = await writeProfile(dir, profile);
    const profileHash = hashFile(profilePath);

    // Build manifest
    const outputPath = "contract/generated/ddd-typedriven.stele";
    const manifest = buildManifest({
      profileHash,
      architectures: result.architectures,
      coreNodes: result.coreNodes,
      outputFiles: [{ path: outputPath, content: result.combined }],
    });

    // Write manifest and generated file
    writeManifest(dir, manifest);
    await writeGeneratedFile(dir, outputPath, result.combined);

    // Verify integrity
    const integrity = verifyManifestIntegrity(dir);
    expect(integrity.valid).toBe(true);
    expect(integrity.drifts).toEqual([]);

    // Verify ownership
    const ownership = validateOwnership(dir);
    expect(ownership.owned).toBe(true);
    expect(ownership.orphanCount).toBe(0);
    expect(ownership.missingCount).toBe(0);
    expect(ownership.unexpectedEdits).toEqual([]);
  });

  it("detects drift after tampering with generated file", async () => {
    const dir = await createTempDir();

    const profile: DesignProfile = {
      schema_version: 1,
      kind: "stele-design-profile",
      profile_id: "test",
      created_at: "2026-05-19T00:00:00.000Z",
      updated_at: "2026-05-19T00:00:00.000Z",
      project: {
        language: "typescript",
        source_roots: ["src"],
        ignore: [],
      },
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: { domain: "src/billing/domain/**/*.ts" },
          },
        ],
      },
    };

    const result = generateFromProfile(brand(profile));
    const outputPath = "contract/generated/ddd-typedriven.stele";
    const manifest = buildManifest({
      profileHash: "profile-hash",
      architectures: result.architectures,
      coreNodes: result.coreNodes,
      outputFiles: [{ path: outputPath, content: result.combined }],
    });

    writeManifest(dir, manifest);
    // Write tampered content
    await writeGeneratedFile(dir, outputPath, result.combined + "\n(tampered)");

    // Ownership should detect the edit
    const ownership = validateOwnership(dir);
    expect(ownership.owned).toBe(false);
    expect(ownership.unexpectedEdits.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("verifyManifestIntegrity returns drift when manifest is missing", async () => {
    const dir = await createTempDir();
    const result = verifyManifestIntegrity(dir);
    expect(result.valid).toBe(false);
    expect(result.drifts).toContain("manifest-not-found");
  });

  it("manifest with empty generatedFiles is handled gracefully", async () => {
    const dir = await createTempDir();
    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "abc",
      generatedRules: [],
      generatedAt: new Date().toISOString(),
      generatedFiles: [],
    };

    writeManifest(dir, manifest);
    const read = readManifest(dir);
    expect(read).not.toBeNull();
    expect(read!.generatedFiles).toEqual([]);
  });

  it("buildManifest handles empty architectures and coreNodes", () => {
    const manifest = buildManifest({
      profileHash: "hash",
      architectures: [],
      coreNodes: [],
    });

    expect(manifest.generatedRules).toHaveLength(0);
  });
});
