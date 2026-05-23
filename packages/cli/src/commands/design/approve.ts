import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

import { hashFile } from "../../design-profile/hash.js";
import { loadProfile, profilePathExists } from "../../design-profile/load.js";
import { readManifest } from "../../design-generator/manifest.js";
import { computeDesignDiff } from "./diff.js";
import type { DesignProfile } from "../../design-profile/types.js";

export type DesignApproveOptions = {
  from?: string;        // Path to previous profile for field-level diff
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

  const currentProfile = loadProfile(projectDir);
  const profileHash = hashFile(resolve(projectDir, "contract/design/profile.yaml"));
  const manifest = readManifest(projectDir);
  const baseHash = manifest?.profileHash ?? null;

  // Compute field-level diff classification using computeDesignDiff
  let diffClassification: string = "additive";
  let affectedSourceScope: string[] = [];

  // Try to obtain the old profile for a proper diff
  let oldProfile: DesignProfile | null = null;

  // 1. If --from is provided, load from that path
  if (opts.from) {
    try {
      const fromPath = resolve(projectDir, opts.from);
      const raw = readFileSync(fromPath, "utf8");
      oldProfile = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as DesignProfile;
    } catch {
      process.stderr.write(`[design] Could not read previous profile at ${opts.from}\n`);
    }
  }

  // 2. If not from --from, try to load from latest approval record
  if (!oldProfile && manifest?.approved_profile_sha256) {
    oldProfile = loadPreviousApprovedProfile(projectDir);
  }

  // 3. Use computeDesignDiff if we have an old profile
  if (oldProfile) {
    const diff = computeDesignDiff(oldProfile, currentProfile);
    diffClassification = diff.overallClass;
    affectedSourceScope = extractAffectedSourceScope(diff, currentProfile);
  } else if (baseHash && baseHash === profileHash) {
    // Profile unchanged from baseline
    diffClassification = "additive";
  }
  // else: first approval or no old profile — default to "additive"

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
    diff_classification: diffClassification,
    affected_generated_rules: manifest?.generatedRules.map((r) => r.ruleId) ?? [],
    affected_source_scope: affectedSourceScope,
    reason: opts.reason,
    approved_by: process.env.CLAUDE_SESSION_ID ?? process.env.USER ?? process.env.USERNAME ?? "human",
    approved_at: new Date().toISOString(),
  };

  writeFileSync(approvalPath, JSON.stringify(approval, null, 2), "utf8");
  process.stdout.write(`[design] Approval written to ${approvalPath}\n`);
  process.stdout.write(`[design] Classification: ${diffClassification}\n`);
}

/**
 * Load the previously approved design profile by reading the latest approval record
 * and attempting to reconstruct the old profile from stored data or git history.
 * Returns null if no previous profile can be found.
 */
function loadPreviousApprovedProfile(projectDir: string): DesignProfile | null {
  const approvalsDir = resolve(projectDir, "contract/design/approvals");
  try {
    const entries = require("node:fs").readdirSync(approvalsDir).filter((f: string) => f.endsWith(".json"));
    if (entries.length === 0) return null;

    entries.sort();
    const latestApprovalPath = resolve(approvalsDir, entries[entries.length - 1]);
    const approvalData = JSON.parse(readFileSync(latestApprovalPath, "utf8"));

    // If the approval stored the full profile, use it
    if (approvalData.profile_snapshot) {
      return approvalData.profile_snapshot as DesignProfile;
    }

    // Try to get old profile from git HEAD
    const profilePath = "contract/design/profile.yaml";
    try {
      const { execFileSync } = require("node:child_process");
      const oldContent = execFileSync("git", ["show", `HEAD:${profilePath}`], {
        cwd: projectDir,
        encoding: "utf8",
      });
      return yaml.load(String(oldContent), { schema: yaml.JSON_SCHEMA }) as DesignProfile;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Extract affected source scope from design diff results.
 * Maps diff changes to source paths based on context roots and aggregate targets.
 */
function extractAffectedSourceScope(
  diff: { changes: Array<{ field: string; newValue?: string; oldValue?: string }> },
  profile: DesignProfile,
): string[] {
  const scopes = new Set<string>();

  for (const change of diff.changes) {
    // Context root changes affect the context's source root
    if (change.field.startsWith("ddd.contexts.") && change.field.endsWith(".root")) {
      const contextId = change.field.split(".")[2];
      const context = profile.ddd?.contexts?.find((c) => c.id === contextId);
      if (context?.root) {
        scopes.add(context.root);
      }
    }

    // Aggregate target changes affect the target file path
    if (change.field.includes(".aggregate_roots.") && change.field.includes(".target")) {
      if (change.newValue) scopes.add(change.newValue);
      if (change.oldValue) scopes.add(change.oldValue);
    }

    // Source root changes directly affect those paths
    if (change.field.startsWith("project.source_roots.")) {
      if (change.newValue) scopes.add(change.newValue);
      if (change.oldValue) scopes.add(change.oldValue);
    }

    // Layer changes affect context roots
    if (change.field.startsWith("ddd.contexts.") && change.field.includes(".layers.")) {
      const contextId = change.field.split(".")[2];
      const context = profile.ddd?.contexts?.find((c) => c.id === contextId);
      if (context?.root) {
        scopes.add(context.root);
      }
    }
  }

  return [...scopes].sort();
}
