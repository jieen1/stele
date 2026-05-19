import { loadProfile } from "../../design-profile/load.js";

export type DesignCheckOptions = {
  profileOnly?: boolean;
  json?: boolean;
};

export async function runDesignCheck(_opts: DesignCheckOptions, projectDir = process.cwd()): Promise<void> {
  const profile = await loadProfile(projectDir);
  process.stdout.write(`[design] Profile schema ${profile.schemaVersion} loaded. Check: coming soon.\n`);
}
