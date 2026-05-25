/**
 * Phase 5.3 self-dogfooding — DESIGN_PROFILE_LIFECYCLE phantom types.
 *
 * A design profile starts Raw (just parsed from YAML), passes through
 * Validated (validateProfile returned no errors) and ends Hashed
 * (a content-addressable SHA-256 has been attached). The generator
 * must only consume a Hashed profile — feeding a Raw or Validated
 * profile to generation skips the integrity gate.
 */

import { resolve } from "node:path";
import type { Sha256 } from "@stele/core";
import { hashFile } from "./hash.js";
import { loadProfile } from "./load.js";
import type { DesignProfile } from "./types.js";

export type DesignProfileState = "Raw" | "Validated" | "Hashed";

export type DesignProfileStateBrand<S extends DesignProfileState> = {
  readonly [K in DesignProfileState as `__profile_state_${K}`]: K extends S ? true : never;
};

export type TypedDesignProfile<S extends DesignProfileState = "Raw"> = DesignProfile &
  DesignProfileStateBrand<S>;

/**
 * Phase 5.3 augmentation: a Hashed profile carries its content hash
 * alongside the branded type so generators receive everything they need
 * without re-reading the YAML.
 */
export interface HashedDesignProfile {
  readonly profile: TypedDesignProfile<"Hashed">;
  readonly contentHash: Sha256;
}

/**
 * Tag a freshly-loaded profile as Raw. Pure type-level operation.
 */
export function asRawProfile(profile: DesignProfile): TypedDesignProfile<"Raw"> {
  return profile as TypedDesignProfile<"Raw">;
}

/**
 * Promote a Raw profile to Validated once `validateProfile()` has
 * accepted it.
 */
export function markProfileValidated(
  profile: TypedDesignProfile<"Raw">,
): TypedDesignProfile<"Validated"> {
  return profile as unknown as TypedDesignProfile<"Validated">;
}

/**
 * Promote a Validated profile to Hashed once its SHA-256 has been
 * computed. Returns the pair so downstream consumers (generators) can
 * cite the hash without re-hashing.
 */
export function hashValidatedProfile(
  profile: TypedDesignProfile<"Validated">,
  contentHash: Sha256,
): HashedDesignProfile {
  return {
    profile: profile as unknown as TypedDesignProfile<"Hashed">,
    contentHash,
  };
}

/**
 * Closeout 4 (self-dogfooding plan): single sanctioned entry for
 * production callers that need a profile + its content hash. Internally
 * chains `loadProfile → asRawProfile → markProfileValidated →
 * hashValidatedProfile`. Every downstream consumer reads `.profile` for
 * the YAML fields and `.contentHash` for the SHA-256.
 *
 * `loadProfile` (the free function in `load.ts`) is retained for the
 * `useProfile` test path that needs raw profile shapes without forcing
 * lifecycle threading through every fixture; production code goes
 * through `loadHashedProfile`.
 */
export function loadHashedProfile(
  projectDir: string,
  profilePath: string = "contract/design/profile.yaml",
): HashedDesignProfile {
  const profile = loadProfile(projectDir, profilePath);
  // validateProfile already ran inside loadProfile; mark Validated.
  const raw = asRawProfile(profile);
  const validated = markProfileValidated(raw);
  const contentHash = hashFile(resolve(projectDir, profilePath));
  return hashValidatedProfile(validated, contentHash);
}
