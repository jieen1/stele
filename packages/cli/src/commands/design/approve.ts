import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { hashFile } from "../../design-profile/hash.js";
import { profilePathExists } from "../../design-profile/load.js";
import { readManifest } from "../../design-generator/manifest.js";

export type DesignApproveOptions = {
  from?: string;
  reason?: string;
};

export async function runDesignApprove(
  opts: DesignApproveOptions,
  projectDir: string = process.cwd(),
): Promise<void> {
  if (!opts.reason) {
    process.stderr.write("[design] --reason is required\n");
    process.exitCode = 1;
    return;
  }

  if (!profilePathExists(projectDir)) {
    process.stderr.write("[design] No profile found\n");
    process.exitCode = 1;
    return;
  }

  const profileHash = hashFile(resolve(projectDir, "contract/design/profile.yaml"));
  const manifest = readManifest(projectDir);
  const baseHash = manifest?.profileHash ?? null;

  // Write approval record
  const approvalsDir = resolve(projectDir, "contract/design/approvals");
  mkdirSync(approvalsDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 22);
  const shortHash = profileHash.slice(0, 8);
  const approvalPath = resolve(approvalsDir, `${ts}-${shortHash}.json`);

  const approval = {
    schema_version: 1,
    base_profile_sha256: baseHash,
    approved_profile_sha256: profileHash,
    diff_classification: baseHash && baseHash === profileHash ? "additive" : "restructuring",
    affected_generated_rules: manifest?.generatedRules.map((r) => r.ruleId) ?? [],
    affected_source_scope: [],
    reason: opts.reason,
    approved_by: "human",
    approved_at: new Date().toISOString(),
  };

  writeFileSync(approvalPath, JSON.stringify(approval, null, 2), "utf8");
  process.stdout.write(`[design] Approval written to ${approvalPath}\n`);
}
