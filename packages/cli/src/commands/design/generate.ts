import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

import { loadProfile, profilePathExists } from "../../design-profile/load.js";
import { validateProfile } from "../../design-profile/validate.js";
import { hashFile } from "../../design-profile/hash.js";
import { buildManifest, writeManifest } from "../../design-generator/manifest.js";
import { generateFromProfile } from "../../design-generator/ddd.js";
import type { ProvenanceOutput, ProvenanceRule } from "../../design-generator/manifest.js";
import { getGitInfo } from "../../events/git.js";
import { STELE_VERSION } from "../../version.js";

export type DesignGenerateOptions = {
  dryRun?: boolean;
  force?: boolean;
  reason?: string;
};

export async function runDesignGenerate(opts: DesignGenerateOptions, projectDir: string = process.cwd()): Promise<void> {
  // 1. Check profile exists
  if (!profilePathExists(projectDir)) {
    process.stderr.write("[design] No profile found at contract/design/profile.yaml\n");
    process.exitCode = 1;
    return;
  }

  // 2. Load + validate profile
  const profile = await loadProfile(projectDir);
  const validationErrors = validateProfile(profile);
  if (validationErrors.length > 0) {
    process.stderr.write("[design] Profile validation errors:\n");
    for (const err of validationErrors) {
      process.stderr.write(`  ${err.field}: ${err.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // 3. Generate from profile
  const result = generateFromProfile(profile);

  // 4. Write generated file
  const generatedPath = resolve(projectDir, "contract/generated/ddd-typedriven.stele");
  const generatedContent = result.combined;

  if (!opts.dryRun) {
    mkdirSync(dirname(generatedPath), { recursive: true });
    writeFileSync(generatedPath, generatedContent, "utf8");
  }

  // 5. Build + write manifest with provenance outputs
  const profileHash = hashFile(resolve(projectDir, "contract/design/profile.yaml"));
  const gitInfo = await getGitInfo(projectDir);

  // Build provenance outputs with enforcement_level for each generated rule
  const outputs = buildProvenanceOutputs(profile, result, generatedContent);

  const manifest = buildManifest({
    profileHash,
    profilePath: "contract/design/profile.yaml",
    preset: "ddd-typedriven",
    generator: {
      package: "@stele/cli",
      version: STELE_VERSION,
      git_sha: gitInfo.commit ?? "unknown",
    },
    templates: ["ddd-typedriven"],
    architectures: result.architectures,
    coreNodes: result.coreNodes,
    outputFiles: [{ path: "contract/generated/ddd-typedriven.stele", content: generatedContent }],
    outputs,
  });

  if (!opts.dryRun) {
    writeManifest(projectDir, manifest);
  }

  // 6. Ensure contract/main.stele imports generated file
  if (!opts.dryRun) {
    ensureImportInMain(projectDir);
  }

  process.stdout.write(
    `[design] Generated ${result.architectures.length} architecture(s), ` +
    `${result.coreNodes.length} core-node(s). ` +
    `${opts.dryRun ? "(dry-run)" : "Written to contract/generated/ddd-typedriven.stele"}\n`,
  );
}

/**
 * Build ProvenanceOutput entries with enforcement_level for each generated rule.
 */
function buildProvenanceOutputs(
  profile: ReturnType<typeof loadProfile>,
  result: ReturnType<typeof generateFromProfile>,
  content: string,
): ProvenanceOutput[] {
  const fileHash = createHash("sha256").update(content).digest("hex");
  const rules: ProvenanceRule[] = [];

  // Architecture rules
  if (profile.ddd?.contexts) {
    for (const ctx of profile.ddd.contexts) {
      rules.push({
        id: `architecture.ddd-${ctx.id}`,
        kind: "architecture",
        origins: [{
          decision_id: `ddd-context-${ctx.id}`,
          profile_anchor: `ddd.contexts.${ctx.id}`,
          question_id: "Q1",
          selected_option: profile.ddd.bounded_context_strategy ?? "by_business_function",
        }],
        enforcement_level: "hard",
        source: "generated",
      });
    }
  }

  // ACL integration rule
  if (profile.ddd?.integrations && profile.ddd.integrations.length > 0) {
    rules.push({
      id: "architecture.ddd-context-map",
      kind: "architecture",
      origins: [{
        decision_id: "q1-bounded-contexts",
        profile_anchor: "ddd.integrations",
        question_id: "Q1",
        selected_option: profile.ddd.bounded_context_strategy ?? "by_business_function",
      }],
      enforcement_level: "hard",
      source: "generated",
    });
  }

  // Core-node rules
  if (profile.ddd?.contexts) {
    for (const ctx of profile.ddd.contexts) {
      for (const agg of ctx.aggregate_roots ?? []) {
        rules.push({
          id: `core-node.${ctx.id}-${agg.id}-aggregate`,
          kind: "core-node",
          origins: [{
            decision_id: `aggregate-${ctx.id}-${agg.id}`,
            profile_anchor: `ddd.contexts.${ctx.id}.aggregate_roots`,
            question_id: "Q2",
            selected_option: agg.id,
          }],
          enforcement_level: "partial",
          source: "generated",
        });
      }
    }
  }

  return [
    {
      path: "contract/generated/ddd-typedriven.stele",
      sha256: fileHash,
      rules,
    },
  ];
}

/**
 * Ensure contract/main.stele imports the generated DDD file.
 * Robust check: creates file if missing, appends import only if not present.
 * Never overwrites existing content.
 */
function ensureImportInMain(projectDir: string): void {
  const mainPath = resolve(projectDir, "contract/main.stele");
  // Import path is resolved relative to dirname(main.stele) = contract/
  // So use path relative to contract/, not the project root.
  const targetPath = "generated/ddd-typedriven.stele";
  const importLine = `(import "${targetPath}")`;

  if (!existsSync(mainPath)) {
    // Create main.stele with the import
    mkdirSync(dirname(mainPath), { recursive: true });
    writeFileSync(mainPath, `${importLine}\n`, "utf8");
    return;
  }

  const content = readFileSync(mainPath, "utf8");

  // Robust check: look for the import line (with possible whitespace variations)
  const normalizedImport = importLine.replace(/\s+/g, " ");
  const lines = content.split("\n");
  const hasImport = lines.some((line) => {
    const normalized = line.trim().replace(/\s+/g, " ");
    return normalized === normalizedImport;
  });

  if (!hasImport) {
    // Append import, ensuring proper newline separation
    const prefix = content.endsWith("\n") ? "" : "\n";
    writeFileSync(mainPath, content + `${prefix}${importLine}\n`, "utf8");
  }
}
