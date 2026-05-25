/**
 * Phase 5.3 type-state self-protection — compile-time test for
 * `DESIGN_PROFILE_LIFECYCLE` phantom-state discipline.
 *
 * To re-verify the brand by hand: remove one `@ts-expect-error`
 * comment, run `pnpm --filter @stele/cli typecheck`, expect TS2345.
 */

import { sha256Branded, type Sha256 } from "@stele/core";
import {
  asRawProfile,
  hashValidatedProfile,
  markProfileValidated,
  useHashedProfile,
  type TypedDesignProfile,
} from "../src/design-profile/lifecycle.js";
import type { DesignProfile } from "../src/design-profile/types.js";

const sample = {
  project: {
    language: "typescript",
    source_roots: ["packages/"],
    ignore: [],
  },
} as unknown as DesignProfile;

const sha: Sha256 = sha256Branded("0".repeat(64));

// Happy path — Raw → Validated → Hashed.
const raw: TypedDesignProfile<"Raw"> = asRawProfile(sample);
const validated: TypedDesignProfile<"Validated"> = markProfileValidated(raw);
const { profile: hashed } = hashValidatedProfile(validated, sha);
void hashed;

// 1. Cannot hash a Raw profile — validation must run first.
// @ts-expect-error — Raw cannot be passed where Validated is required
hashValidatedProfile(raw, sha);

// 2. Cannot re-mark a Hashed profile as Validated; the lifecycle is forward-only.
// @ts-expect-error — Hashed cannot be passed where Raw is required
markProfileValidated(hashed);

// 3. A raw DesignProfile is not assignable to TypedDesignProfile<"Raw"> without
//    going through asRawProfile.
// @ts-expect-error — DesignProfile is not assignable to TypedDesignProfile<"Raw">
const smuggled: TypedDesignProfile<"Raw"> = sample;
void smuggled;

// 4. Closeout 4: `useHashedProfile` accepts only `TypedDesignProfile<"Hashed">`.
//    Passing a Raw brand MUST fail — the read site is the runtime gate
//    that validation + hashing transitions ran first.
// @ts-expect-error — Raw cannot be passed where useHashedProfile requires Hashed
useHashedProfile(raw);
