import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
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

  return profile;
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
