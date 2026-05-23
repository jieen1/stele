// Phase B T3.4 — design-generator trace-policy rendering tests.
//
// Covers byte-stable CDL emission for `(trace-policy ...)` declarations
// from the design profile's `trace:` section, including snake_case →
// kebab-case field-name translation, optional-field omission, exempt
// entries, fix-hint preservation, and multi-policy ordering.

import { describe, expect, it } from "vitest";
import type {
  DesignProfile,
  TracePolicySpec,
  TraceSection,
} from "../src/design-profile/types.js";
import {
  renderTracePolicy,
  renderTraceSection,
} from "../src/design-generator/render-stele.js";
import { generateFromProfile } from "../src/design-generator/ddd.js";

function minimalPolicy(overrides: Partial<TracePolicySpec> = {}): TracePolicySpec {
  return {
    id: "DB_VIA_REPOSITORY",
    target: ["**/db/**::*"],
    must_transit: ["**/repository/**::*"],
    ...overrides,
  };
}

function minimalProfile(trace?: TraceSection): DesignProfile {
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
    trace,
  };
}

describe("renderTraceSection — empty", () => {
  it("returns empty string for undefined section", () => {
    expect(renderTraceSection(undefined)).toBe("");
  });

  it("returns empty string for an empty policies array", () => {
    expect(renderTraceSection({ policies: [] })).toBe("");
  });
});

describe("renderTracePolicy — minimal", () => {
  it("renders id, target, and one must-* constraint only", () => {
    const cdl = renderTracePolicy(minimalPolicy());
    expect(cdl).toContain('(trace-policy "DB_VIA_REPOSITORY"');
    expect(cdl).toContain('(target "**/db/**::*")');
    expect(cdl).toContain('(must-transit "**/repository/**::*")');
    expect(cdl.trimEnd().endsWith(")")).toBe(true);
  });

  it("does NOT emit optional fields that are absent", () => {
    const cdl = renderTracePolicy(minimalPolicy());
    expect(cdl).not.toContain("(description");
    expect(cdl).not.toContain("(severity");
    expect(cdl).not.toContain("(scope");
    expect(cdl).not.toContain("(exempt");
    expect(cdl).not.toContain("(fix-hint");
    expect(cdl).not.toContain("(must-be-preceded-by");
    expect(cdl).not.toContain("(must-be-followed-by");
    expect(cdl).not.toContain("(deny-direct");
    expect(cdl).not.toContain("(deny-transit");
  });
});

describe("renderTracePolicy — snake_case → kebab-case", () => {
  it("translates must_transit → must-transit", () => {
    const cdl = renderTracePolicy(minimalPolicy({ must_transit: ["**/r/**::*"] }));
    expect(cdl).toContain("(must-transit");
    expect(cdl).not.toContain("must_transit");
  });

  it("translates must_be_preceded_by → must-be-preceded-by", () => {
    const cdl = renderTracePolicy(
      minimalPolicy({ must_be_preceded_by: ["**/perm/**::verify"] }),
    );
    expect(cdl).toContain('(must-be-preceded-by "**/perm/**::verify")');
    expect(cdl).not.toContain("must_be_preceded_by");
  });

  it("translates must_be_followed_by → must-be-followed-by", () => {
    const cdl = renderTracePolicy(
      minimalPolicy({ must_be_followed_by: ["**/audit/**::write"] }),
    );
    expect(cdl).toContain('(must-be-followed-by "**/audit/**::write")');
  });

  it("translates deny_direct → deny-direct and deny_transit → deny-transit", () => {
    const cdl = renderTracePolicy(
      minimalPolicy({
        deny_direct: ["**/controllers/**::*"],
        deny_transit: ["**/dark-mirror/**::*"],
      }),
    );
    expect(cdl).toContain('(deny-direct "**/controllers/**::*")');
    expect(cdl).toContain('(deny-transit "**/dark-mirror/**::*")');
  });

  it("translates fix_hint → fix-hint", () => {
    const cdl = renderTracePolicy(
      minimalPolicy({ fix_hint: "Insert `permission.verify(...)` before write" }),
    );
    expect(cdl).toContain('(fix-hint');
    expect(cdl).not.toContain("fix_hint");
  });
});

describe("renderTracePolicy — severity", () => {
  it('renders explicit severity "error"', () => {
    const cdl = renderTracePolicy(minimalPolicy({ severity: "error" }));
    expect(cdl).toContain('(severity "error")');
  });

  it('renders explicit severity "warning"', () => {
    const cdl = renderTracePolicy(minimalPolicy({ severity: "warning" }));
    expect(cdl).toContain('(severity "warning")');
  });
});

describe("renderTracePolicy — scope, exempt, fix-hint", () => {
  it("renders scope with multiple patterns separated by space", () => {
    const cdl = renderTracePolicy(
      minimalPolicy({ scope: ["**/services/**::*", "**/handlers/**::*"] }),
    );
    expect(cdl).toContain('(scope "**/services/**::*" "**/handlers/**::*")');
  });

  it("renders one exempt entry with its reason", () => {
    const cdl = renderTracePolicy(
      minimalPolicy({
        exempt: [{ pattern: "**/legacy/**::*", reason: "Pre-refactor scope" }],
      }),
    );
    expect(cdl).toContain(
      '(exempt "**/legacy/**::*" (reason "Pre-refactor scope"))',
    );
  });

  it("renders multiple exempt entries on separate lines, preserving order", () => {
    const cdl = renderTracePolicy(
      minimalPolicy({
        exempt: [
          { pattern: "**/legacy/**::*", reason: "Tracked in TICKET-1" },
          { pattern: "**/admin/**::*", reason: "Out of scope" },
        ],
      }),
    );
    const firstIdx = cdl.indexOf('"**/legacy/**::*"');
    const secondIdx = cdl.indexOf('"**/admin/**::*"');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("preserves backticks inside fix-hint and escapes the wrapping quotes", () => {
    const hint = 'Use `Repository.find` instead of `db.query("SELECT *")`';
    const cdl = renderTracePolicy(minimalPolicy({ fix_hint: hint }));
    // backticks are preserved; the inner `"` is backslash-escaped by escapeString
    expect(cdl).toContain("`Repository.find`");
    expect(cdl).toContain('SELECT *\\"');
  });
});

describe("renderTracePolicy — full schema", () => {
  it("renders every supported field in a fixed deterministic order", () => {
    const cdl = renderTracePolicy({
      id: "FULL_POLICY",
      description: "All fields exercised",
      severity: "warning",
      target: ["extern:typeorm::*"],
      must_transit: ["**/repo/**::*"],
      must_be_preceded_by: ["**/perm/**::verify"],
      must_be_followed_by: ["**/audit/**::write"],
      deny_direct: ["**/controllers/**::*"],
      deny_transit: ["**/legacy/**::*"],
      scope: ["**/services/**::*"],
      exempt: [{ pattern: "**/skip/**::*", reason: "Tracked" }],
      fix_hint: "Use `Repo.find` at src/handler.ts:42",
    });
    // sanity: every label appears exactly once
    for (const label of [
      "(description",
      "(severity",
      "(target",
      "(must-transit",
      "(must-be-preceded-by",
      "(must-be-followed-by",
      "(deny-direct",
      "(deny-transit",
      "(scope",
      "(exempt",
      "(fix-hint",
    ]) {
      const occurrences = cdl.split(label).length - 1;
      expect(occurrences).toBe(1);
    }
    // deterministic order: description appears before target, target before
    // must-transit, must-transit before deny-direct, etc.
    expect(cdl.indexOf("(description")).toBeLessThan(cdl.indexOf("(severity"));
    expect(cdl.indexOf("(severity")).toBeLessThan(cdl.indexOf("(target"));
    expect(cdl.indexOf("(target")).toBeLessThan(cdl.indexOf("(must-transit"));
    expect(cdl.indexOf("(must-transit")).toBeLessThan(
      cdl.indexOf("(must-be-preceded-by"),
    );
    expect(cdl.indexOf("(must-be-followed-by")).toBeLessThan(
      cdl.indexOf("(deny-direct"),
    );
    expect(cdl.indexOf("(deny-direct")).toBeLessThan(cdl.indexOf("(deny-transit"));
    expect(cdl.indexOf("(deny-transit")).toBeLessThan(cdl.indexOf("(scope"));
    expect(cdl.indexOf("(scope")).toBeLessThan(cdl.indexOf("(exempt"));
    expect(cdl.indexOf("(exempt")).toBeLessThan(cdl.indexOf("(fix-hint"));
  });
});

describe("renderTraceSection — multiple policies", () => {
  it("joins policies with exactly one blank line, in authored order", () => {
    const section: TraceSection = {
      policies: [
        minimalPolicy({ id: "ALPHA" }),
        minimalPolicy({ id: "BETA" }),
        minimalPolicy({ id: "GAMMA" }),
      ],
    };
    const cdl = renderTraceSection(section);
    const alphaIdx = cdl.indexOf("ALPHA");
    const betaIdx = cdl.indexOf("BETA");
    const gammaIdx = cdl.indexOf("GAMMA");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    expect(gammaIdx).toBeGreaterThan(betaIdx);
    // Separator is exactly one blank line between policies.
    expect(cdl).toContain(")\n\n(trace-policy");
    // No double-blank between policies.
    expect(cdl).not.toContain(")\n\n\n(trace-policy");
  });
});

describe("renderTraceSection — byte stability", () => {
  it("running render twice on the same input yields identical bytes", () => {
    const section: TraceSection = {
      policies: [
        {
          id: "POL_A",
          description: "x",
          severity: "error",
          target: ["**/a/**::*"],
          must_transit: ["**/b/**::*", "**/c/**::*"],
          deny_direct: ["**/d/**::*"],
          scope: ["**/svc/**::*"],
          exempt: [{ pattern: "**/legacy/**::*", reason: "tracked" }],
          fix_hint: "Use `find` at src/x.ts:1",
        },
        minimalPolicy({ id: "POL_B" }),
      ],
    };
    const first = renderTraceSection(section);
    const second = renderTraceSection(section);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe("generateFromProfile — trace integration", () => {
  it("omits trace section entirely when profile.trace is undefined (byte stability)", () => {
    const profile = minimalProfile(undefined);
    const out = generateFromProfile(profile);
    expect(out.combined).toBe("");
    expect(out.manifest.outputs[0]?.rule_count).toBe(0);
  });

  it("emits trace-policy block when trace section has policies", () => {
    const profile = minimalProfile({
      policies: [
        minimalPolicy({ id: "DEMO", fix_hint: "Use `Repo.find` at src/x.ts:1" }),
      ],
    });
    const out = generateFromProfile(profile);
    expect(out.combined).toContain('(trace-policy "DEMO"');
    expect(out.combined).toContain("(must-transit");
    expect(out.manifest.outputs[0]?.rule_count).toBe(1);
  });
});
