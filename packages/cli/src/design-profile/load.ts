import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import type { DesignProfile } from "./types.js";

const DEFAULT_PROFILE_PATH = "contract/design/profile.yaml";

/**
 * Load a design profile from YAML and return a typed object.
 *
 * @param projectDir - The project root directory.
 * @param profilePath - Relative path to the profile file (default: contract/design/profile.yaml).
 */
export function loadProfile(
  projectDir: string,
  profilePath = DEFAULT_PROFILE_PATH,
): DesignProfile {
  const fullPath = resolve(projectDir, profilePath);
  const text = readFileSync(fullPath, "utf8");
  const parsed = yaml.load(text) as DesignProfile;
  return parsed;
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
