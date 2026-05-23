import { describe, expect, it } from "vitest";
import { SteleError, parseFile } from "../src/index";
import type { ListNode } from "../src/index";
import { parseExternAliasDeclaration } from "../src/validator/structure-extern-alias.js";
import type { ExternAliasDeclaration } from "../src/validator/structure-types.js";

const FILE_PATH = "test.stele";

function parseTopList(source: string): ListNode {
  const parsed = parseFile(source, FILE_PATH);
  const node = parsed.body[0];
  if (node === undefined || node.kind !== "list") {
    throw new Error(`Expected top-level list node, got ${node?.kind ?? "undefined"}`);
  }
  return node;
}

function parseExternAlias(source: string): ExternAliasDeclaration {
  return parseExternAliasDeclaration(FILE_PATH, parseTopList(source));
}

function expectSteleError(
  fn: () => unknown,
  expectation: { code: string; messageIncludes: string },
): void {
  expect(fn).toThrowError(SteleError);
  try {
    fn();
  } catch (err) {
    expect((err as SteleError).code).toBe(expectation.code);
    expect((err as SteleError).message).toContain(expectation.messageIncludes);
  }
}

describe("parseExternAliasDeclaration — happy path", () => {
  it("accepts a declaration with all five language bindings + description", () => {
    const result = parseExternAlias(
      `(extern-alias stripe
         (description "Stripe SDK across all backends")
         (typescript "stripe")
         (python "stripe")
         (go "github.com/stripe/stripe-go/v74")
         (java "com.stripe:stripe-java")
         (rust "stripe-rust"))`,
    );
    expect(result.kind).toBe("extern-alias");
    expect(result.id).toBe("stripe");
    expect(result.description).toBe("Stripe SDK across all backends");
    expect(result.typescript).toBe("stripe");
    expect(result.python).toBe("stripe");
    expect(result.go).toBe("github.com/stripe/stripe-go/v74");
    expect(result.java).toBe("com.stripe:stripe-java");
    expect(result.rust).toBe("stripe-rust");
  });

  it("accepts a single-language binding", () => {
    const result = parseExternAlias(`(extern-alias stripe (typescript "stripe"))`);
    expect(result.id).toBe("stripe");
    expect(result.typescript).toBe("stripe");
    expect(result.python).toBeUndefined();
    expect(result.go).toBeUndefined();
    expect(result.java).toBeUndefined();
    expect(result.rust).toBeUndefined();
  });

  it("accepts a string-literal logical name", () => {
    const result = parseExternAlias(`(extern-alias "stripe-sdk" (typescript "stripe"))`);
    expect(result.id).toBe("stripe-sdk");
  });
});

describe("parseExternAliasDeclaration — error cases", () => {
  it("E0360: rejects missing logical name", () => {
    expectSteleError(
      () => parseExternAlias(`(extern-alias (typescript "stripe"))`),
      { code: "E0360", messageIncludes: "logical-name" },
    );
  });

  it("E0360: rejects a bare-atom field (not wrapped in list)", () => {
    expectSteleError(
      () => parseExternAlias(`(extern-alias stripe typescript)`),
      { code: "E0360", messageIncludes: "unsupported entry" },
    );
  });

  it("E0361: rejects an unknown field", () => {
    expectSteleError(
      () =>
        parseExternAlias(
          `(extern-alias stripe (typescript "stripe") (kotlin "stripe"))`,
        ),
      { code: "E0361", messageIncludes: 'unknown field "kotlin"' },
    );
  });

  it("E0363: rejects a declaration with no language bindings", () => {
    expectSteleError(
      () => parseExternAlias(`(extern-alias stripe (description "no bindings here"))`),
      { code: "E0363", messageIncludes: "no language bindings" },
    );
  });
});
