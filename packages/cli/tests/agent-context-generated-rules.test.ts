import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STELE_CONFIG_FILE, DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildAgentContext, type GeneratedRuleSource } from "../src/commands/agentContext.js";
import { writeManifest, type GenerationManifest, type ProvenanceOutput, type ProvenanceRule } from "../src/design-generator/manifest.js";
import { hashString } from "../src/design-profile/hash.js";

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
  const dir = await mkdtemp(join(tmpdir(), "stele-generated-rules-"));
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
// Test 1: generated_rule_sources populated from manifest outputs
// ---------------------------------------------------------------------------

describe("buildAgentContext -- generated_rule_sources from outputs", () => {
  it("populates generated_rule_sources when manifest has outputs", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeContract(projectDir, "");

    const provenanceRule: ProvenanceRule = {
      id: "ddd-billing",
      kind: "architecture",
      origins: [
        {
          decision_id: "q1-bounded-contexts",
          profile_anchor: "contexts.billing",
          question_id: "q1",
          selected_option: "billing_context",
        },
      ],
      enforcement_level: "hard",
      source: "generated",
    };

    const output: ProvenanceOutput = {
      path: "contract/generated/ddd-billing.stele",
      sha256: hashString("(architecture \"ddd-billing\" (lang typescript) (deny-cycles))"),
      rules: [provenanceRule],
    };

    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "profile-hash-123",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedRules: [],
      outputs: [output],
    };
    writeManifest(projectDir, manifest);

    const context = await buildAgentContext(projectDir);

    expect(context.generated_rule_sources).toBeDefined();
    expect(context.generated_rule_sources!).toHaveLength(1);

    const source = context.generated_rule_sources![0];
    expect(source.rule_id).toBe("ddd-billing");
    expect(source.profile_anchor).toBe("contexts.billing");
    expect(source.decision_id).toBe("q1-bounded-contexts");
    expect(source.enforcement_level).toBe("hard");
  });

  it("populates multiple sources from multiple outputs and rules", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeContract(projectDir, "");

    const billingRule: ProvenanceRule = {
      id: "ddd-billing",
      kind: "architecture",
      origins: [
        {
          decision_id: "q1",
          profile_anchor: "contexts.billing",
          question_id: "q1",
          selected_option: "billing",
        },
      ],
      enforcement_level: "hard",
      source: "generated",
    };

    const customerRule: ProvenanceRule = {
      id: "ddd-customer",
      kind: "core-node",
      origins: [
        {
          decision_id: "q2",
          profile_anchor: "contexts.customer",
          question_id: "q2",
          selected_option: "customer",
        },
      ],
      enforcement_level: "advisory",
      source: "generated",
    };

    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "profile-hash-456",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedRules: [],
      outputs: [
        {
          path: "contract/generated/ddd-billing.stele",
          sha256: hashString("(architecture \"ddd-billing\" (lang typescript))"),
          rules: [billingRule],
        },
        {
          path: "contract/generated/ddd-customer.stele",
          sha256: hashString("(core-node \"customer-aggregate\" (target \"src/customer/Aggregate.ts\"))"),
          rules: [customerRule],
        },
      ],
    };
    writeManifest(projectDir, manifest);

    const context = await buildAgentContext(projectDir);

    expect(context.generated_rule_sources).toBeDefined();
    expect(context.generated_rule_sources!).toHaveLength(2);

    expect(context.generated_rule_sources!).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: "ddd-billing",
          enforcement_level: "hard",
        }),
        expect.objectContaining({
          rule_id: "ddd-customer",
          enforcement_level: "advisory",
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: Fallback to generatedRules when no outputs
// ---------------------------------------------------------------------------

describe("buildAgentContext -- generated_rule_sources fallback to generatedRules", () => {
  it("populates from generatedRules when outputs is empty", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeContract(projectDir, "");

    const cdl = '(architecture "ddd-billing" (lang typescript) (deny-cycles))';
    const cnCdl = '(core-node "billing-invoice-aggregate" (target "src/billing/Invoice.ts"))';
    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "profile-hash-789",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedRules: [
        {
          ruleId: "architecture.ddd-billing",
          ruleKind: "architecture",
          origin: "context:billing",
          origins: [{ type: "context", context_id: "billing", context_name: "Billing" }],
          fileHash: hashString(cdl),
          cdl,
        },
        {
          ruleId: "core-node.billing-invoice-aggregate",
          ruleKind: "core-node",
          origin: "aggregate:invoice",
          origins: [{ type: "aggregate", aggregate_id: "invoice" }],
          fileHash: hashString(cnCdl),
          cdl: cnCdl,
        },
      ],
    };
    writeManifest(projectDir, manifest);

    const context = await buildAgentContext(projectDir);

    expect(context.generated_rule_sources).toBeDefined();
    expect(context.generated_rule_sources!).toHaveLength(2);

    const archSource = context.generated_rule_sources!.find((s) => s.rule_id === "architecture.ddd-billing");
    expect(archSource).toBeDefined();
    expect(archSource!.profile_anchor).toBe("context:billing");
    expect(archSource!.enforcement_level).toBe("hard");
    expect(archSource!.decision_id).toBe("billing");

    const cnSource = context.generated_rule_sources!.find((s) => s.rule_id === "core-node.billing-invoice-aggregate");
    expect(cnSource).toBeDefined();
    expect(cnSource!.profile_anchor).toBe("aggregate:invoice");
    expect(cnSource!.enforcement_level).toBe("advisory");
    expect(cnSource!.decision_id).toBe("invoice");
  });
});

// ---------------------------------------------------------------------------
// Test 3: No manifest means no generated_rule_sources
// ---------------------------------------------------------------------------

describe("buildAgentContext -- no manifest", () => {
  it("has undefined generated_rule_sources when no manifest exists", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeContract(projectDir, "");

    const context = await buildAgentContext(projectDir);

    expect(context.generated_rule_sources).toBeUndefined();
  });

  it("has undefined generated_rule_sources when manifest has empty generatedRules and no outputs", async () => {
    const projectDir = await createTempDir();
    writeConfig(projectDir);
    writeContract(projectDir, "");

    const manifest: GenerationManifest = {
      schemaVersion: "1",
      profileHash: "empty-profile",
      generatedAt: "2026-05-20T00:00:00.000Z",
      generatedRules: [],
    };
    writeManifest(projectDir, manifest);

    const context = await buildAgentContext(projectDir);

    expect(context.generated_rule_sources).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 4: GeneratedRuleSource type shape
// ---------------------------------------------------------------------------

describe("GeneratedRuleSource type", () => {
  it("has the expected fields and enforcement level union", () => {
    const source: GeneratedRuleSource = {
      rule_id: "test-rule",
      profile_anchor: "test-anchor",
      decision_id: "test-decision",
      enforcement_level: "hard",
    };

    expect(source.rule_id).toBe("test-rule");
    expect(source.profile_anchor).toBe("test-anchor");
    expect(source.decision_id).toBe("test-decision");
    expect(source.enforcement_level).toBe("hard");

    // Verify other enforcement levels are valid
    const partialSource: GeneratedRuleSource = {
      ...source,
      enforcement_level: "partial",
    };
    expect(partialSource.enforcement_level).toBe("partial");

    const advisorySource: GeneratedRuleSource = {
      ...source,
      enforcement_level: "advisory",
    };
    expect(advisorySource.enforcement_level).toBe("advisory");
  });
});
