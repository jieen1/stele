import { loadProfile } from "../../design-profile/load.js";

export type DesignGenerateOptions = {
  dryRun?: boolean;
  force?: boolean;
  reason?: string;
};

export async function runDesignGenerate(_opts: DesignGenerateOptions, projectDir = process.cwd()): Promise<void> {
  const profile = await loadProfile(projectDir);
  process.stdout.write(`[design] Profile loaded (schema: ${profile.schemaVersion}). Generate: coming soon.\n`);
}
