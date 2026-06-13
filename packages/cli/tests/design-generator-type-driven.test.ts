import { describe, expect, it } from "vitest";
import type { DesignProfile } from "../src/design-profile/types.js";
import { generateFromProfile } from "../src/design-generator/ddd.js";
import {
  renderBrandedId,
  renderTypeDrivenDeclarations,
  resolveBrandedIdTarget,
} from "../src/design-generator/render-stele.js";
import {
  asRawProfile,
  markProfileValidated,
  hashValidatedProfile,
  type TypedDesignProfile,
} from "../src/design-profile/lifecycle.js";
import { hashString } from "../src/design-profile/hash.js";

const brand = (p: DesignProfile): TypedDesignProfile<"Hashed"> =>
  hashValidatedProfile(markProfileValidated(asRawProfile(p)), hashString(JSON.stringify(p)))
    .profile;

function minimalProfile(): DesignProfile {
  return {
    schema_version: 1,
    kind: "ddd-typedriven",
    profile_id: "test",
    created_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-19T00:00:00.000Z",
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: [],
      tsconfig: "tsconfig.json",
    },
  };
}

describe("renderBrandedId", () => {
  it("renders all fields", () => {
    const cdl = renderBrandedId({
      name: "RuleId",
      type_target: "packages/core/src/util/branded-types.ts::RuleId",
      // base_type/invariant/entity_scope from yaml shape
      ...({ base_type: "string", invariant: "matches /^[a-z]+$/", entity_scope: "src/**" } as Record<string, unknown>),
    });
    expect(cdl).toContain('(branded-id "RuleId"');
    expect(cdl).toContain('(target "packages/core/src/util/branded-types.ts::RuleId")');
    expect(cdl).toContain('(base-type "string")');
    expect(cdl).toContain('(pattern "/^[a-z]+$/")');
    expect(cdl).toContain('(entity-scope "src/**")');
  });

  it("omits pattern when invariant is absent", () => {
    const cdl = renderBrandedId({
      name: "X",
      type_target: "f.ts::X",
      ...({ base_type: "string" } as Record<string, unknown>),
    });
    expect(cdl).not.toContain("(pattern");
  });
});

describe("resolveBrandedIdTarget", () => {
  it("returns explicit target when provided", () => {
    expect(resolveBrandedIdTarget("X", "explicit.ts::X")).toBe("explicit.ts::X");
  });
  it("falls back to canonical branded-types module", () => {
    expect(resolveBrandedIdTarget("RuleId", undefined)).toBe(
      "packages/core/src/util/branded-types.ts::RuleId",
    );
  });
});

describe("renderTypeDrivenDeclarations", () => {
  it("returns empty arrays when type_driven absent", () => {
    const out = renderTypeDrivenDeclarations(minimalProfile());
    expect(out.brandedIds).toEqual([]);
  });

  it("renders branded-id from profile.type_driven", () => {
    const profile: DesignProfile = {
      ...minimalProfile(),
      type_driven: {
        enabled: true,
        branded_ids: {
          mode: "hard",
          declarations: [
            { name: "RuleId", ...({ base_type: "string", invariant: "matches /^[a-z]+$/" } as Record<string, unknown>) },
          ],
        },
        adt: { mode: "hard" },
        type_state: { mode: "hard" },
      },
    };
    const out = renderTypeDrivenDeclarations(profile);
    expect(out.brandedIds).toHaveLength(1);
    expect(out.brandedIds[0]).toContain('(branded-id "RuleId"');
  });
});

describe("generateFromProfile — type-driven integration", () => {
  it("emits branded-id blocks in combined output", () => {
    const profile: DesignProfile = {
      ...minimalProfile(),
      type_driven: {
        enabled: true,
        branded_ids: {
          mode: "hard",
          declarations: [
            { name: "RuleId", ...({ base_type: "string", invariant: "matches /^[a-z]+$/" } as Record<string, unknown>) },
          ],
        },
        adt: { mode: "hard" },
        type_state: { mode: "hard" },
      },
    };
    const result = generateFromProfile(brand(profile));
    expect(result.brandedIds).toHaveLength(1);
    expect(result.combined).toContain('(branded-id "RuleId"');
  });

  it("output is byte-stable across repeated calls", () => {
    const profile: DesignProfile = {
      ...minimalProfile(),
      type_driven: {
        enabled: true,
        branded_ids: {
          mode: "hard",
          declarations: [
            { name: "A", ...({ base_type: "string", invariant: "matches /^a/" } as Record<string, unknown>) },
            { name: "B", ...({ base_type: "string", invariant: "matches /^b/" } as Record<string, unknown>) },
          ],
        },
        adt: { mode: "hard" },
        type_state: { mode: "hard" },
      },
    };
    const r1 = generateFromProfile(brand(profile));
    const r2 = generateFromProfile(brand(profile));
    expect(r1.combined).toBe(r2.combined);
  });
});
