import { execFileSync } from "node:child_process";
// `writeFileSync` is re-imported (unused locally — production callers
// go through `writeSignedApproval`) so the
// `trace.APPROVE_VIA_RESOLVE_APPROVED_BY.missing_predecessor` negative
// test can inject a bypass function calling `writeFileSync` directly
// and prove the trace policy still catches it. The `void writeFileSync`
// below keeps strict noUnusedLocals quiet.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
void writeFileSync;
import { resolve } from "node:path";
import * as yaml from "js-yaml";

import { hashFile } from "../../design-profile/hash.js";
import { profilePathExists } from "../../design-profile/load.js";
import { loadHashedProfile } from "../../design-profile/lifecycle.js";
import { readManifest } from "../../design-generator/manifest.js";
import { computeDesignDiff } from "./diff.js";
import type { DesignProfile } from "../../design-profile/types.js";
import { ExitCode } from "../../errors.js";
import {
  attachApprovedBy,
  draftApproval,
  signApproval,
  writeSignedApproval,
  type ApprovalPayload,
} from "./approval-lifecycle.js";

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
  // human attribution.
  "dogfood", "selfprotect", "self-protect", "autotest",
  "mock", "fake", "fixture", "placeholder", "noreply", "robot",
  // Round 11 R-01: when the value is split on non-identifier chars,
  // tokens like `round_10` produce `round` + `10` — both must be
  // rejected on their own. `round` and `iter` are the canonical
  // round/iteration token roots; `r` is too generic (real usernames
  // like `r` exist) so only `round` is banned as a literal.
  "round", "iter",
]);
// Round 10 Q-04 + Round 11 R-01: regex patterns that reject
// self-referential round/iteration labels after splitting on
// non-identifier chars. `round\d+` and `iter\d+` are the canonical
// agent-self-attestation forms. Single-letter prefixes (r1, p1) are
// NOT matched here — they appear too often in legitimate usernames /
// employee IDs to ban as a class.
const _APPROVED_BY_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^round\d+$/i,
  /^iter\d+$/i,
];

export function resolveApprovedBy(): { ok: true; approvedBy: string } | { ok: false; reason: string } {
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
    // Round 10 Q-04 + Round 11 R-01: split on EVERY non-identifier
    // character (not just `:` / `@`), then for each resulting token
    // reject it if it equals any forbidden literal OR contains one as
    // a sub-word boundary OR matches a forbidden round/r pattern.
    // R-01 verified that splitting on `:` / `@` alone left bypasses
    // via `.`, `-`, `_`, etc. — e.g. `dogfood.round10:ok` passed.
    const tokens = trimmed
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const tok of tokens) {
      if (_APPROVED_BY_FORBIDDEN_LITERALS.has(tok)) {
        return {
          ok: false,
          reason:
            `STELE_APPROVED_BY=${trimmed} contains forbidden token "${tok}". ` +
            "Use a real human-identifying token (email or service:ci where no sub-token is a self-attesting placeholder).",
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
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }

  // Round 4 D-02 follow-up: structural prerequisites (profile exists) are
  // checked BEFORE the human-identity gate so the user gets the more
  // specific error first. The identity gate only runs when the profile
  // is actually in shape to be approved.
  if (!profilePathExists(projectDir)) {
    process.stderr.write("[design] No profile found\n");
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }

  const approverResult = resolveApprovedBy();
  if (!approverResult.ok) {
    process.stderr.write(`[design] ${approverResult.reason}\n`);
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }

  // Closeout 4: typed DESIGN_PROFILE_LIFECYCLE chain.
  const currentProfile = loadHashedProfile(projectDir).profile;
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

  // Round 13 M-10: bind the approval to the proposal SHA-256s present
  // in contract/design/proposals/ at the time of approval. Together
  // with `approved_profile_sha256` this lets `stele design generate`
  // detect a class of stealth attack: an agent that creates a new
  // proposal AFTER approval (or mutates an existing one) is now visible
  // because the proposal-hash list won't match. Generate enforces that
  // every recorded proposal either still exists with the same hash OR
  // has been deleted (i.e. merged into the approved profile).
  const approvedProposals = readProposalsAtApproval(projectDir);

  const approvalPayload: ApprovalPayload = {
    schema_version: 1,
    base_profile_sha256: baseHash,
    approved_profile_sha256: profileHash,
    approved_proposals: approvedProposals,
    diff_classification: diffClassification,
    affected_generated_rules: manifest?.generatedRules.map((r) => r.ruleId) ?? [],
    affected_source_scope: affectedSourceScope,
    reason: opts.reason,
    // Round 4 D-02: approved_by comes from the human-identity gate above,
    // not from CLAUDE_SESSION_ID / USER env defaults an agent inherits.
    approved_by: approverResult.approvedBy,
    approved_at: new Date().toISOString(),
  };

  // Closeout 4 (self-dogfooding plan): route through the typed
  // APPROVAL_LIFECYCLE chain — Drafting → IdentityChecked → Signed.
  // The persist site `writeSignedApproval` only accepts a
  // `Approval<"Signed">`, so a caller that skips a step does not compile
  // (tsc rejects a non-Signed value).
  const drafting = draftApproval(approvalPayload);
  const identityChecked = attachApprovedBy(drafting);
  const signed = signApproval(identityChecked);
  writeSignedApproval(signed, approvalPath);
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
 * Round 13 M-10: snapshot the proposal YAML files in
 * `contract/design/proposals/` at the time of approval. Each entry is
 * `{ path: string; sha256: string }`. The list is sorted by path for
 * byte-stable approval records. The generate flow re-reads these and
 * refuses to write if a recorded proposal has been mutated (new
 * content) or a NEW proposal has appeared without a fresh approval.
 *
 * Proposals that have been deleted (i.e. merged into the profile) are
 * accepted as long as the corresponding profile change is reflected
 * in the approved profile hash.
 */
function readProposalsAtApproval(projectDir: string): Array<{ path: string; sha256: string }> {
  const proposalsDir = resolve(projectDir, "contract/design/proposals");
  let entries: string[];
  try {
    entries = readdirSync(proposalsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    // No proposals directory = no proposals to bind to.
    return [];
  }
  entries.sort();
  const out: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries) {
    try {
      const sha = hashFile(resolve(proposalsDir, entry));
      out.push({ path: `contract/design/proposals/${entry}`, sha256: sha });
    } catch {
      // Skip unreadable entries — they won't be approved.
    }
  }
  return out;
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
