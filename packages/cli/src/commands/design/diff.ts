import { resolve } from "node:path";

import { profilePathExists } from "../../design-profile/load.js";
import { hashFile } from "../../design-profile/hash.js";
import { readManifest } from "../../design-generator/manifest.js";

export type DesignDiffOptions = {
  from?: string;
  json?: boolean;
};

export interface DesignDiffChange {
  changeClass: "additive" | "tightening" | "weakening" | "restructuring";
  field: string;
  description: string;
}

export interface DesignDiffResult {
  baseProfileHash: string | null;
  currentProfileHash: string;
  changes: DesignDiffChange[];
  affectedRules: string[];
}

export async function runDesignDiff(
  opts: DesignDiffOptions,
  projectDir: string = process.cwd(),
): Promise<void> {
  const result = await diffDesign(opts, projectDir);
  const out = opts.json ? JSON.stringify(result, null, 2) : formatDiff(result);
  process.stdout.write(out + "\n");
}

async function diffDesign(_opts: DesignDiffOptions, projectDir: string): Promise<DesignDiffResult> {
  if (!profilePathExists(projectDir)) {
    return {
      baseProfileHash: null,
      currentProfileHash: "",
      changes: [],
      affectedRules: [],
    };
  }

  const currentHash = hashFile(resolve(projectDir, "contract/design/profile.yaml"));
  const manifest = readManifest(projectDir);
  const baseHash = manifest?.profileHash ?? null;

  const changes: DesignDiffChange[] = [];

  if (baseHash && baseHash !== currentHash) {
    changes.push({
      changeClass: "restructuring",
      field: "profile",
      description: `Profile hash changed (${baseHash.slice(0, 12)}... → ${currentHash.slice(0, 12)}...)`,
    });
  }

  const affectedRules = manifest?.generatedRules.map((r) => r.ruleId) ?? [];

  return {
    baseProfileHash: baseHash,
    currentProfileHash: currentHash,
    changes,
    affectedRules,
  };
}

function formatDiff(result: DesignDiffResult): string {
  const lines: string[] = [];

  lines.push("Design diff:");
  lines.push(`  Base profile hash: ${result.baseProfileHash ? result.baseProfileHash.slice(0, 16) + "..." : "none"}`);
  lines.push(`  Current profile hash: ${result.currentProfileHash.slice(0, 16)}...`);

  if (result.changes.length === 0) {
    lines.push("  No changes detected.");
  } else {
    lines.push(`  Changes (${result.changes.length}):`);
    for (const change of result.changes) {
      lines.push(`    [${change.changeClass}] ${change.field}: ${change.description}`);
    }
  }

  lines.push(`  Affected rules: ${result.affectedRules.length}`);

  return lines.join("\n");
}
