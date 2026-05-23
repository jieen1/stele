// Byte-stability snapshot for the design-generator render path.
//
// This test guards against accidental byte drift in
// `contract/generated/ddd-typedriven.stele`, which is a protected file:
// any change to its bytes invalidates user manifest verification. The
// snapshot's reference is the on-disk protected file itself plus a
// captured JSON of the loaded profile, so this test cross-checks that
// `loadProfile` + `generateFromProfile` together reproduce the artifact
// exactly.
//
// If you touch any helper under design-generator/render/, this test must
// keep passing without edits. If you intentionally regenerate the
// contract, update the golden JSON in the same change.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadProfile } from "../src/design-profile/load.js";
import { generateFromProfile } from "../src/design-generator/ddd.js";
import type { DesignProfile } from "../src/design-profile/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const GOLDEN_DIR = resolve(__dirname, "golden-snapshots");

describe("render-stele byte-stability", () => {
  it("loaded profile matches captured JSON snapshot", () => {
    const profile = loadProfile(REPO_ROOT);
    const captured = JSON.parse(
      readFileSync(resolve(GOLDEN_DIR, "render-stele.profile.json"), "utf8"),
    ) as DesignProfile;
    expect(profile).toStrictEqual(captured);
  });

  it("generateFromProfile(combined) matches the protected on-disk artifact byte-for-byte", () => {
    const profile = loadProfile(REPO_ROOT);
    const expected = readFileSync(
      resolve(REPO_ROOT, "contract/generated/ddd-typedriven.stele"),
      "utf8",
    );
    const result = generateFromProfile(profile);
    expect(result.combined).toBe(expected);
  });

  it("generateFromProfile(combined) matches the captured golden snapshot", () => {
    const profile = loadProfile(REPO_ROOT);
    const expected = readFileSync(
      resolve(GOLDEN_DIR, "render-stele.golden.stele"),
      "utf8",
    );
    const result = generateFromProfile(profile);
    expect(result.combined).toBe(expected);
  });
});
