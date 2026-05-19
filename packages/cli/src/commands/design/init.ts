import { resolve } from "node:path";
import { loadProfile, profilePathExists } from "../../design-profile/load.js";

export type DesignInitOptions = {
  preset?: string;
  answers?: string;
  dryRun?: boolean;
  generate?: boolean;
  replace?: boolean;
};

export async function runDesignInit(_opts: DesignInitOptions, projectDir = process.cwd()): Promise<void> {
  const profile = await loadProfile(projectDir);
  if (profilePathExists(projectDir)) {
    process.stdout.write(`[design] Profile exists at default path: ${profile.schemaVersion}\n`);
  } else {
    process.stdout.write("[design] No profile found. Use --preset to scaffold.\n");
  }
}
