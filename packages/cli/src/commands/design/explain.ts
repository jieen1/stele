import { loadProfile } from "../../design-profile/load.js";

export type DesignExplainOptions = {
  json?: boolean;
};

export async function runDesignExplain(_target: string, _opts: DesignExplainOptions, projectDir = process.cwd()): Promise<void> {
  const profile = await loadProfile(projectDir);
  process.stdout.write(`[design] Explain target loaded. Profile schema: ${profile.schemaVersion}. Explain: coming soon.\n`);
}
