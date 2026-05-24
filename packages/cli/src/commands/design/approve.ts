import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Round 4 D-02: human-identity gate. `stele design approve` writes the
 * approval record that gates `stele design generate`. If anyone running
 * the CLI can mint approvals, the entire P0-4 design gate is rubber-
 * stampable. We require BOTH:
 *
 *   - An interactive TTY (`process.stdin.isTTY === true`), OR
 *   - An explicit `STELE_APPROVED_BY` env var with a non-empty value that
 *     does NOT match the default values an agent's shell would inherit
 *     (CLAUDE_SESSION_ID, USER, USERNAME). The env var must be set by a
 *     human who deliberately authorized this CLI invocation.
 *
 * The `approved_by` field on the written approval record is sourced from
 * the env-var (if present) or defaults to "tty:<USER>" — never from the
 * Claude session id alone.
 */
/**
 * Round 5 I-02 + J-01: enforce the docstring's denylist that Round 4
 * advertised but never implemented. STELE_APPROVED_BY accepted only when
 * it is non-empty, longer than 2 chars, does NOT equal the agent's
 * inherited shell defaults (CLAUDE_SESSION_ID, USER, USERNAME), is not
 * the literal word "agent" / "bot" / "claude" / "tty", and carries a
 * non-default token shape (contains `@` for an email, OR `:` for a
 * scoped identifier like `service:ci`). Without this an agent that
 * exports STELE_APPROVED_BY=anything bypasses the gate trivially.
 */
const _APPROVED_BY_FORBIDDEN_LITERALS = new Set([
  "agent", "bot", "claude", "tty", "human", "user", "service",
  "test", "ci", "unknown", "anonymous", "stele", "approved",
  // Round 10 Q-04: also reject self-attesting placeholders that
  // mechanically satisfy the `:` / `@` requirement but carry no
  // human attribution. These are tokens an agent would naturally
  // construct (`dogfood:roundN-XYZ`, `selfprotect:autotest`) when
  // trying to mint approvals without operator involvement.
  "dogfood", "selfprotect", "self-protect", "autotest",
  "mock", "fake", "fixture", "placeholder", "noreply", "robot",
]);
// Round 10 Q-04: regex patterns that reject self-referential prefixes
// across `:` / `@` splits. `dogfood:roundN-XYZ` is rejected because
// `dogfood` is forbidden as a left token; `round9-p01` matches the
// `roundN` pattern.
const _APPROVED_BY_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^round[\s-]?\d+$/i,
  /^r\d+$/i,
];

function resolveApprovedBy(): { ok: true; approvedBy: string } | { ok: false; reason: string } {
  const explicit = process.env.STELE_APPROVED_BY;
  if (typeof explicit === "string") {
    const trimmed = explicit.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        reason:
          "STELE_APPROVED_BY is set but empty. Set it to a human-identifying token containing `@` (email) or `:` (scoped service id).",
      };
    }
    if (trimmed.length < 3) {
      return {
        ok: false,
        reason: `STELE_APPROVED_BY value too short (${trimmed.length} chars). Use a real human-identifying token.`,
      };
    }
    const lower = trimmed.toLowerCase();
    const inheritedDefaults = new Set(
      [process.env.CLAUDE_SESSION_ID, process.env.USER, process.env.USERNAME, process.env.LOGNAME]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .map((v) => v.toLowerCase()),
    );
    if (inheritedDefaults.has(lower)) {
      return {
        ok: false,
        reason:
          `STELE_APPROVED_BY=${trimmed} matches a shell-inherited default (CLAUDE_SESSION_ID/USER/USERNAME/LOGNAME). ` +
          "An agent's inherited env is not an attribution source. Set it to a real human-identifying token.",
      };
    }
    if (_APPROVED_BY_FORBIDDEN_LITERALS.has(lower)) {
      return {
        ok: false,
        reason:
          `STELE_APPROVED_BY=${trimmed} is too generic. Use a token containing \`@\` (email) or \`:\` (scoped service id like service:ci).`,
      };
    }
    const hasShape = trimmed.includes("@") || trimmed.includes(":");
    if (!hasShape) {
      return {
        ok: false,
        reason:
          `STELE_APPROVED_BY=${trimmed} must contain \`@\` (email) or \`:\` (scoped id like service:ci). ` +
          "Pure bare strings are not attributable.",
      };
    }
    // Round 10 Q-04: also reject self-referential prefixes on either
    // side of the `:` / `@` split. An attacker that synthesises
    // `dogfood:roundN-XYZ` only needs the literal denylist to miss the
    // exact whole-string match — splitting catches that.
    const tokens = trimmed.split(/[:@]/u).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
    for (const tok of tokens) {
      if (_APPROVED_BY_FORBIDDEN_LITERALS.has(tok)) {
        return {
          ok: false,
          reason:
            `STELE_APPROVED_BY=${trimmed} contains forbidden token "${tok}". ` +
            "Use a real human-identifying token (email or service:ci where neither half is a self-attesting placeholder).",
        };
      }
      if (_APPROVED_BY_FORBIDDEN_PATTERNS.some((re) => re.test(tok))) {
        return {
          ok: false,
          reason:
            `STELE_APPROVED_BY=${trimmed} contains a round-number / r-prefix placeholder "${tok}". ` +
            "Use a real human-identifying token, not a release / round / iteration label.",
        };
      }
    }
    return { ok: true, approvedBy: trimmed };
  }
  if (process.stdin.isTTY) {
    const user = process.env.USER ?? process.env.USERNAME ?? "unknown";
    return { ok: true, approvedBy: `tty:${user}` };
  }
  return {
    ok: false,
    reason:
      "stele design approve requires either an interactive TTY OR the STELE_APPROVED_BY env var set to a non-empty human-identifying token (containing `@` or `:`). " +
      "An agent invocation via Bash without one of these is refused; the approval would be unattributable.",
  };
}

export async function runDesignApprove(
  opts: DesignApproveOptions,
  projectDir: string = process.cwd(),
): Promise<void> {
  if (!opts.reason) {
    process.stderr.write("[design] --reason is required\n");
    process.exitCode = 1;
    return;
  }

  // Round 4 D-02 follow-up: structural prerequisites (profile exists) are
  // checked BEFORE the human-identity gate so the user gets the more
  // specific error first. The identity gate only runs when the profile
  // is actually in shape to be approved.
  if (!profilePathExists(projectDir)) {
    process.stderr.write("[design] No profile found\n");
    process.exitCode = 1;
    return;
  }

  const approverResult = resolveApprovedBy();
  if (!approverResult.ok) {
    process.stderr.write(`[design] ${approverResult.reason}\n`);
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
    // Round 4 D-02: approved_by comes from the human-identity gate above,
    // not from CLAUDE_SESSION_ID / USER env defaults an agent inherits.
    approved_by: approverResult.approvedBy,
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
  // Round 4 D-14: replace require() calls with top-of-file ESM imports
  // (readdirSync + execFileSync). The legacy code threw at runtime under
  // strict ESM if this fallback path was taken.
  const approvalsDir = resolve(projectDir, "contract/design/approvals");
  try {
    const entries = readdirSync(approvalsDir).filter((f: string) => f.endsWith(".json"));
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

    // Round 10 Q-06: layer_dependencies changes also affect the
    // context root — without this, an additive dependency bump (e.g.
    // `report → domain-primitives`) shows an EMPTY affected-source
    // scope to the human reviewer, understating the blast radius.
    if (change.field.startsWith("ddd.contexts.") && change.field.includes(".layer_dependencies")) {
      const contextId = change.field.split(".")[2];
      const context = profile.ddd?.contexts?.find((c) => c.id === contextId);
      if (context?.root) {
        scopes.add(context.root);
      }
    }
  }

  return [...scopes].sort();
}
