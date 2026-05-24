/**
 * Phase 5.3 self-dogfooding — DESIGN_PROFILE_LIFECYCLE phantom types.
 *
 * A design profile starts Raw (just parsed from YAML), passes through
 * Validated (validateProfile returned no errors) and ends Hashed
 * (a content-addressable SHA-256 has been attached). The generator
 * must only consume a Hashed profile — feeding a Raw or Validated
 * profile to generation skips the integrity gate.
 */

import type { Sha256 } from "@stele/core";
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
