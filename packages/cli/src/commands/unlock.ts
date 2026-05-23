import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { STELE_BASELINE_FILE } from "../config/defaults.js";
import { loadConfig } from "../config/loadConfig.js";
import { isMissingFileError } from "../utils/shared-utils.js";

export type UnlockOptions = {
  reason: string;
  confirm?: boolean;
};

export type UnlockSummary = {
  manifestPath: string;
  baselinePath: string;
};

export async function unlockProject(projectDir: string, options: UnlockOptions): Promise<UnlockSummary> {
  if (!options.confirm) {
    process.stdout.write(
      "[stele] WARNING: This will temporarily remove manifest and baseline locks.\n" +
        "Only use when the normal lock/unlock flow is broken.\n" +
        "Re-run 'stele lock --reason \"...\"' after manual edits.\n\n" +
        "Add --confirm to proceed.\n",
    );
    throw new Error("Use --confirm to proceed.");
  }

  const config = await loadConfig(projectDir);
  const manifestPath = resolve(projectDir, config.manifestPath);
  const baselinePath = resolve(projectDir, STELE_BASELINE_FILE);

  const removed: string[] = [];

  try {
    await rm(manifestPath);
    removed.push(config.manifestPath);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  try {
    await rm(baselinePath);
    removed.push(STELE_BASELINE_FILE);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await writeUnlockLog(projectDir, {
    reason: options.reason,
    removed,
    timestamp: new Date().toISOString(),
  });

  return {
    manifestPath: config.manifestPath,
    baselinePath: STELE_BASELINE_FILE,
  };
}


async function writeUnlockLog(projectDir: string, entry: UnlockLogEntry): Promise<void> {
  const logDir = resolve(projectDir, "contract");
  const logFile = resolve(logDir, ".unlock-log.jsonl");
  await mkdir(logDir, { recursive: true });

  const line = JSON.stringify(entry) + "\n";

  try {
    const existing = await readFile(logFile, "utf8");
    await writeFile(logFile, existing + line);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    await writeFile(logFile, line);
  }
}

type UnlockLogEntry = {
  reason: string;
  removed: string[];
  timestamp: string;
};
