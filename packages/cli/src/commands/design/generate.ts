import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { loadProfile, profilePathExists } from "../../design-profile/load.js";
import { validateProfile } from "../../design-profile/validate.js";
import { hashFile } from "../../design-profile/hash.js";
import { buildManifest, writeManifest } from "../../design-generator/manifest.js";
import { generateFromProfile } from "../../design-generator/ddd.js";

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

  // 5. Build + write manifest
  const profileHash = hashFile(resolve(projectDir, "contract/design/profile.yaml"));
  const manifest = buildManifest({
    profileHash,
    architectures: result.architectures,
    coreNodes: result.coreNodes,
    outputFiles: [{ path: "contract/generated/ddd-typedriven.stele", content: generatedContent }],
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
 * Ensure contract/main.stele imports the generated DDD file.
 */
function ensureImportInMain(projectDir: string): void {
  const mainPath = resolve(projectDir, "contract/main.stele");
  const targetPath = "contract/generated/ddd-typedriven.stele";

  if (!existsSync(mainPath)) {
    return;
  }

  const content = readFileSync(mainPath, "utf8");
  if (!content.includes(`(import "${targetPath}")`)) {
    writeFileSync(mainPath, content + `\n(import "${targetPath}")\n`, "utf8");
  }
}
