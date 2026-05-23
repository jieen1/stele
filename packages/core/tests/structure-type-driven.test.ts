import { describe, expect, it } from "vitest";
import type { ListNode } from "../src/index";
import { SteleError, parseFile } from "../src/index";
import {
  parseBrandedIdDeclaration,
  parseSmartCtorDeclaration,
} from "../src/validator/structure-type-driven.js";

const FILE_PATH = "test.stele";

function parseTopList(source: string): ListNode {
  const parsed = parseFile(source, FILE_PATH);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error(`Expected top-level list node, got ${node?.kind ?? "undefined"}`);
  }

  return node;
}

function expectSteleError(
  fn: () => unknown,
  expectation: { code: string; messageIncludes: string },
): void {
  expect(fn).toThrowError(SteleError);

  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SteleError);
    expect((err as SteleError).code).toBe(expectation.code);
    expect((err as SteleError).message).toContain(expectation.messageIncludes);
  }
}

describe("parseBrandedIdDeclaration", () => {
  it("parses a full branded-id with target, base-type, pattern, entity-scope", () => {
    const node = parseTopList(
      '(branded-id RuleId\n' +
      '  (target "packages/core/src/ast/types.ts::RuleId")\n' +
      '  (base-type string)\n' +
      '  (pattern "/^[a-z][a-z0-9_.]*$/")\n' +
      '  (entity-scope "packages/core/src/**"))',
    );
    const result = parseBrandedIdDeclaration(FILE_PATH, node);
    expect(result.kind).toBe("branded-id");
    expect(result.id).toBe("RuleId");
    expect(result.target).toBe("packages/core/src/ast/types.ts::RuleId");
    expect(result.baseType).toBe("string");
    expect(result.pattern).toBe("/^[a-z][a-z0-9_.]*$/");
    expect(result.entityScope).toBe("packages/core/src/**");
    expect(result.filePath).toBe(FILE_PATH);
  });

  it("parses a minimal branded-id (target + base-type only)", () => {
    const node = parseTopList(
      '(branded-id Sha256 (target "core::Sha256") (base-type string))',
    );
    const result = parseBrandedIdDeclaration(FILE_PATH, node);
    expect(result.id).toBe("Sha256");
    expect(result.pattern).toBeUndefined();
    expect(result.entityScope).toBeUndefined();
  });

  it("rejects branded-id without target", () => {
    const node = parseTopList('(branded-id RuleId (base-type string))');
    expectSteleError(() => parseBrandedIdDeclaration(FILE_PATH, node), {
      code: "E0327",
      messageIncludes: "must declare a (target ...) field",
    });
  });

  it("rejects branded-id without base-type", () => {
    const node = parseTopList('(branded-id RuleId (target "f.ts::RuleId"))');
    expectSteleError(() => parseBrandedIdDeclaration(FILE_PATH, node), {
      code: "E0327",
      messageIncludes: "must declare a (base-type ...) field",
    });
  });

  it("rejects unknown field", () => {
    const node = parseTopList(
      '(branded-id RuleId (target "f.ts::RuleId") (base-type string) (foo "bar"))',
    );
    expectSteleError(() => parseBrandedIdDeclaration(FILE_PATH, node), {
      code: "E0327",
      messageIncludes: 'unknown field "foo"',
    });
  });

  it("rejects duplicate target", () => {
    const node = parseTopList(
      '(branded-id RuleId (target "a.ts::A") (target "b.ts::B") (base-type string))',
    );
    expectSteleError(() => parseBrandedIdDeclaration(FILE_PATH, node), {
      code: "E0327",
      messageIncludes: "may declare",
    });
  });
});

describe("parseSmartCtorDeclaration", () => {
  it("parses a full smart-ctor with constructor and deny-raw", () => {
    const node = parseTopList(
      '(smart-ctor RuleId (constructor "parseRuleId") (deny-raw "true"))',
    );
    const result = parseSmartCtorDeclaration(FILE_PATH, node);
    expect(result.kind).toBe("smart-ctor");
    expect(result.id).toBe("RuleId");
    expect(result.constructorName).toBe("parseRuleId");
    expect(result.denyRaw).toBe(true);
  });

  it("defaults deny-raw to false when not given", () => {
    const node = parseTopList('(smart-ctor RuleId (constructor "parseRuleId"))');
    const result = parseSmartCtorDeclaration(FILE_PATH, node);
    expect(result.denyRaw).toBe(false);
  });

  it("parses deny-raw false", () => {
    const node = parseTopList(
      '(smart-ctor RuleId (constructor "parseRuleId") (deny-raw "false"))',
    );
    const result = parseSmartCtorDeclaration(FILE_PATH, node);
    expect(result.denyRaw).toBe(false);
  });

  it("rejects smart-ctor without constructor", () => {
    const node = parseTopList('(smart-ctor RuleId)');
    expectSteleError(() => parseSmartCtorDeclaration(FILE_PATH, node), {
      code: "E0328",
      messageIncludes: "must declare a (constructor ...) field",
    });
  });

  it("rejects invalid deny-raw value", () => {
    const node = parseTopList(
      '(smart-ctor RuleId (constructor "parseRuleId") (deny-raw "maybe"))',
    );
    expectSteleError(() => parseSmartCtorDeclaration(FILE_PATH, node), {
      code: "E0328",
      messageIncludes: "deny-raw must be true or false",
    });
  });

  it("rejects unknown field", () => {
    const node = parseTopList(
      '(smart-ctor RuleId (constructor "parseRuleId") (bar "baz"))',
    );
    expectSteleError(() => parseSmartCtorDeclaration(FILE_PATH, node), {
      code: "E0328",
      messageIncludes: 'unknown field "bar"',
    });
  });
});

describe("integration with buildContract", () => {
  it("parses branded-id and smart-ctor as top-level declarations", async () => {
    const source =
      '(branded-id RuleId\n' +
      '  (target "packages/core/src/ast/types.ts::RuleId")\n' +
      '  (base-type string))\n' +
      '(smart-ctor RuleId (constructor "parseRuleId") (deny-raw "true"))\n';

    const parsed = parseFile(source, FILE_PATH);
    // Each top-level is a list node; the parser allows the new heads.
    expect(parsed.body).toHaveLength(2);
    expect((parsed.body[0] as ListNode).head).toBe("branded-id");
    expect((parsed.body[1] as ListNode).head).toBe("smart-ctor");
  });
});
