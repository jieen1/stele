import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import { isFixHintActionable } from "@stele/core";
import type { DesignProfile } from "./types.js";
import { validateProfile } from "./validate.js";

const DEFAULT_PROFILE_PATH = "contract/design/profile.yaml";

/**
 * Load a design profile from YAML, validate schema, and return a typed object.
 * Throws on parse or schema errors with structured messages.
 *
 * @param projectDir - The project root directory.
 * @param profilePath - Relative path to the profile file (default: contract/design/profile.yaml).
 */
export function loadProfile(
  projectDir: string,
  profilePath = DEFAULT_PROFILE_PATH,
): DesignProfile {
  const fullPath = resolve(projectDir, profilePath);
  let parsed: unknown;
  try {
    const text = readFileSync(fullPath, "utf8");
    parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new Error(
      `[profile] Failed to parse YAML at ${fullPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[profile] YAML at ${fullPath} did not parse to an object`);
  }

  const profile = parsed as DesignProfile;
  const errors = validateProfile(profile, profilePath);
  if (errors.length > 0) {
    const messages = errors.map((e) => `  ${e.field}: ${e.message}`).join("\n");
    throw new Error(`[profile] Schema validation failed for ${profilePath}:\n${messages}`);
  }

  emitDeprecationNotices(profile);

  return profile;
}

/**
 * Emit human-readable notices for deprecated profile fields. Notices are
 * informational only — they do not affect parse success or validation. Notice
 * output goes to stderr so it does not contaminate stdout pipelines.
 */
function emitDeprecationNotices(profile: DesignProfile): void {
  if (profile.type_driven?.adt !== undefined) {
    process.stderr.write(
      "[notice] design-profile.adt-deprecated\n" +
        "  Your design profile contains 'type_driven.adt' — this field is deprecated and silently ignored. " +
        "Remove it in your next contract update. Will be removed in v0.4.\n",
    );
  }

  // Phase B T3.4: emit a notice (NOT a validation error) for trace policies
  // whose fix_hint is missing or too vague to be agent-actionable. The
  // structural parser rejects vague hints with E0339, but at the profile
  // layer we treat this as a soft warning so users can iterate on their
  // hints without breaking generation.
  for (const policy of profile.trace?.policies ?? []) {
    if (typeof policy.id !== "string") continue;
    const hint = policy.fix_hint;
    if (hint === undefined || hint.length === 0 || !isFixHintActionable(hint)) {
      process.stderr.write(
        "[notice] design-profile.trace-fix-hint-vague\n" +
          `  trace.policies[${policy.id}].fix_hint should contain a code snippet (backticks) or file:line ref. ` +
          "Vague hints reduce agent auto-fix rate.\n",
      );
    }
  }
}

/**
 * Check whether the design profile file exists at the expected location.
 */
export function profilePathExists(
  projectDir: string,
  profilePath = DEFAULT_PROFILE_PATH,
): boolean {
  const fullPath = resolve(projectDir, profilePath);
  return existsSync(fullPath);
}
