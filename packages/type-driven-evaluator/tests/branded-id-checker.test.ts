import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBrandedIds } from "../src/branded-id-checker.js";
import type { BrandedIdDeclaration, BrandedIdCheckOptions } from "../src/types.js";

const FIXTURES = resolve(__dirname, "fixtures");
const tsconfigPath = resolve(FIXTURES, "tsconfig.json");

function makeOptions(
  declarations: BrandedIdDeclaration[],
): BrandedIdCheckOptions {
  return {
    projectDir: FIXTURES,
    tsconfigPath,
    declarations,
  };
}

describe("typescript-shape: branded IDs", () => {
  it("valid: entity uses branded ID type produces no violations", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "InvoiceId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::InvoiceId",
          entityScope: "branded/**/*.ts",
        },
      ]),
    );

    expect(violations).toHaveLength(0);
  });

  it("invalid: entity uses string instead of branded ID produces violations", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "InvoiceId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::InvoiceId",
          entityScope: "branded-invalid/**/*.ts",
        },
      ]),
    );

    expect(violations.length).toBeGreaterThan(0);

    // Check that violations reference the correct file
    const badOrderViolations = violations.filter(
      (v) => v.file.includes("BadOrder.ts"),
    );
    expect(badOrderViolations.length).toBeGreaterThan(0);

    // Check violation details
    for (const v of badOrderViolations) {
      expect(v.message).toContain("InvoiceId");
      expect(v.message).toContain("instead of `string`");
      expect(v.fix).toContain("InvoiceId");
      expect(v.line).toBeGreaterThan(0);
      expect(v.column).toBeGreaterThan(0);
    }
  });

  it("invalid: function parameter uses string instead of branded ID", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "InvoiceId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::InvoiceId",
          entityScope: "branded-invalid/**/*.ts",
        },
      ]),
    );

    const badServiceViolations = violations.filter(
      (v) => v.file.includes("BadService.ts"),
    );

    expect(badServiceViolations.length).toBeGreaterThan(0);
    expect(badServiceViolations[0].message).toContain("Parameter");
    expect(badServiceViolations[0].message).toContain("invoiceId");
  });

  it("missing target file handles gracefully without crash", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "NonExistentId",
          typeTarget: resolve(FIXTURES, "branded", "NonExistent.ts") + "::NonExistentId",
          entityScope: "branded/**/*.ts",
        },
      ]),
    );

    // Should not crash; should produce a violation about missing file
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("not found");
  });

  it("missing type in file handles gracefully without crash", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "GhostId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::GhostId",
          entityScope: "branded/**/*.ts",
        },
      ]),
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("GhostId");
  });

  it("advisory suffix scan (no entityScope) produces no violations", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "InvoiceId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::InvoiceId",
          // No entityScope: advisory mode
        },
      ]),
    );

    expect(violations).toHaveLength(0);
  });

  it("empty declarations returns empty violations", () => {
    const violations = checkBrandedIds(makeOptions([]));
    expect(violations).toEqual([]);
  });

  it("invalid typeTarget format produces graceful error", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "InvoiceId",
          typeTarget: "invalid-format-no-colon-colon",
          entityScope: "branded/**/*.ts",
        },
      ]),
    );

    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("parse");
  });

  it("multiple declarations aggregate violations", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "InvoiceId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::InvoiceId",
          entityScope: "branded-invalid/**/*.ts",
        },
        {
          typeName: "InvoiceId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::InvoiceId",
          entityScope: "branded/**/*.ts",
        },
      ]),
    );

    // First declaration finds violations in bad files
    // Second declaration finds no violations in good files
    const badViolations = violations.filter((v) => v.file.includes("BadOrder") || v.file.includes("BadService"));
    expect(badViolations.length).toBeGreaterThan(0);
  });

  it("field line and column point to the correct location", () => {
    const violations = checkBrandedIds(
      makeOptions([
        {
          typeName: "InvoiceId",
          typeTarget: resolve(FIXTURES, "branded", "InvoiceId.ts") + "::InvoiceId",
          entityScope: "branded-invalid/**/*.ts",
        },
      ]),
    );

    const badOrderViolations = violations.filter(
      (v) => v.file.includes("BadOrder.ts"),
    );

    // BadOrder.ts has `invoiceId: string` at line 2 (property) and line 4 (constructor param)
    // and line 7 (method param)
    const fieldViolation = badOrderViolations.find((v) => v.message.includes("Field"));
    expect(fieldViolation).toBeDefined();
    expect(fieldViolation!.line).toBe(2);
  });
});
