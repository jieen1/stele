import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSmartConstructors,
} from "../src/typescript-shape/smart-constructors.js";
import type {
  SmartConstructorCheckOptions,
  SmartConstructorTarget,
} from "../src/typescript-shape/types.js";

const FIXTURES = resolve(__dirname, "fixtures", "typescript-shape");

const tsconfigPath = resolve(FIXTURES, "tsconfig.json");

function makeOptions(targets: SmartConstructorTarget[]): SmartConstructorCheckOptions {
  return { tsconfigPath, targets };
}

describe("typescript-shape: smart constructor", () => {
  it("valid: private constructor + all factory methods yields 0 violations", () => {
    const results = checkSmartConstructors(
      makeOptions([
        {
          id: "money",
          classTarget: resolve(FIXTURES, "valid", "Money.ts") + "::Money",
          factoryMethods: ["parse", "create"],
        },
      ]),
    );

    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("invalid: public constructor yields violation", () => {
    const results = checkSmartConstructors(
      makeOptions([
        {
          id: "public-key",
          classTarget: resolve(FIXTURES, "invalid", "PublicKey.ts") + "::PublicKey",
          factoryMethods: ["fromPEM"],
        },
      ]),
    );

    expect(results).toHaveLength(1);
    const violations = results[0].violations;
    const constructorViolations = violations.filter(
      (v) => v.message.includes("Smart constructor") || v.message.includes("public"),
    );
    expect(constructorViolations).toHaveLength(1);
    expect(constructorViolations[0].severity).toBe("error");
  });

  it("missing factory method yields violation", () => {
    const results = checkSmartConstructors(
      makeOptions([
        {
          id: "public-key",
          classTarget: resolve(FIXTURES, "invalid", "PublicKey.ts") + "::PublicKey",
          factoryMethods: ["fromPEM", "fromJWK"],
        },
      ]),
    );

    expect(results).toHaveLength(1);
    const missingViolations = results[0].violations.filter(
      (v) => v.message.includes("not found"),
    );
    expect(missingViolations).toHaveLength(1);
    expect(missingViolations[0].message).toContain("fromJWK");
  });

  it("protected constructor yields 0 violations", () => {
    const results = checkSmartConstructors(
      makeOptions([
        {
          id: "order",
          classTarget: resolve(FIXTURES, "protected", "Order.ts") + "::Order",
          factoryMethods: ["create"],
        },
      ]),
    );

    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(0);
  });

  it("multiple targets with mixed results", () => {
    const results = checkSmartConstructors(
      makeOptions([
        {
          id: "money",
          classTarget: resolve(FIXTURES, "valid", "Money.ts") + "::Money",
          factoryMethods: ["parse", "create"],
        },
        {
          id: "public-key",
          classTarget: resolve(FIXTURES, "invalid", "PublicKey.ts") + "::PublicKey",
          factoryMethods: ["fromPEM"],
        },
      ]),
    );

    expect(results).toHaveLength(2);
    expect(results[0].violations).toHaveLength(0);
    expect(results[1].violations.length).toBeGreaterThan(0);
  });

  it("class does not exist yields violation", () => {
    const results = checkSmartConstructors(
      makeOptions([
        {
          id: "non-existent",
          classTarget: resolve(FIXTURES, "valid", "Money.ts") + "::NonExistent",
          factoryMethods: ["parse"],
        },
      ]),
    );

    expect(results).toHaveLength(1);
    expect(results[0].violations).toHaveLength(1);
    expect(results[0].violations[0].message).toContain("NonExistent");
    expect(results[0].violations[0].message).toContain("not found");
  });

  it("empty targets returns empty results", () => {
    const results = checkSmartConstructors(makeOptions([]));
    expect(results).toEqual([]);
  });

  it("rule ID format matches expected pattern", () => {
    const results = checkSmartConstructors(
      makeOptions([
        {
          id: "public-key",
          classTarget: resolve(FIXTURES, "invalid", "PublicKey.ts") + "::PublicKey",
          factoryMethods: ["fromPEM"],
        },
      ]),
    );

    for (const result of results) {
      for (const violation of result.violations) {
        expect(violation.ruleId).toMatch(/^typedriven\.shape\.[a-z-]+$/);
        expect(violation.ruleKind).toBe("typescript-shape");
      }
    }
  });
});
