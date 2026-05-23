import { describe, expect, it } from "vitest";
import type { ListNode } from "../src/index";
import { SteleError, parseFile } from "../src/index";
import {
  parseTypeStateBindingDeclaration,
  type TypeStateBindingDeclaration,
} from "../src/validator/structure-type-state.js";

const FILE_PATH = "test.stele";

function parseTopList(source: string): ListNode {
  const parsed = parseFile(source, FILE_PATH);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error(`Expected top-level list node, got ${node?.kind ?? "undefined"}`);
  }

  return node;
}

function parseBinding(source: string): TypeStateBindingDeclaration {
  return parseTypeStateBindingDeclaration(FILE_PATH, parseTopList(source));
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

describe("parseTypeStateBindingDeclaration — happy path", () => {
  it("parses a binding with a single param", () => {
    const b = parseBinding(
      '(type-state-binding\n' +
        '  (function "src/order/handler.ts::OrderHandler::process(1)")\n' +
        '  (param 0 state Submitted))',
    );
    expect(b.kind).toBe("type-state-binding");
    expect(b.function).toBe("src/order/handler.ts::OrderHandler::process(1)");
    expect(b.params).toHaveLength(1);
    expect(b.params[0]?.index).toBe(0);
    expect(b.params[0]?.state).toBe("Submitted");
    expect(b.filePath).toBe(FILE_PATH);
  });

  it("parses a binding with multiple params at different indices", () => {
    const b = parseBinding(
      '(type-state-binding\n' +
        '  (function "src/payment/handler.ts::PaymentHandler::settle(3)")\n' +
        '  (param 0 state Paid)\n' +
        '  (param 2 state Verified))',
    );
    expect(b.params).toHaveLength(2);
    expect(b.params[0]).toMatchObject({ index: 0, state: "Paid" });
    expect(b.params[1]).toMatchObject({ index: 2, state: "Verified" });
  });

  it("accepts state as a quoted string", () => {
    const b = parseBinding(
      '(type-state-binding\n' +
        '  (function "src/h.ts::H::f(1)")\n' +
        '  (param 0 state "Submitted"))',
    );
    expect(b.params[0]?.state).toBe("Submitted");
  });
});

describe("parseTypeStateBindingDeclaration — error paths", () => {
  it("E0349: missing function throws", () => {
    const node = parseTopList(
      '(type-state-binding (param 0 state Submitted))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: 'must declare a (function',
    });
  });

  it("E0349: function with empty string throws", () => {
    const node = parseTopList(
      '(type-state-binding (function "") (param 0 state Submitted))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "non-empty NodeId",
    });
  });

  it("E0349: missing param throws", () => {
    const node = parseTopList(
      '(type-state-binding (function "src/h.ts::H::f(1)"))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "at least one (param",
    });
  });

  it("E0349: invalid param index (negative) throws", () => {
    const node = parseTopList(
      '(type-state-binding (function "src/h.ts::H::f(1)") (param -1 state Submitted))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "non-negative integer",
    });
  });

  it("E0349: invalid param index (non-number) throws", () => {
    const node = parseTopList(
      '(type-state-binding (function "src/h.ts::H::f(1)") (param "abc" state Submitted))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "non-negative integer",
    });
  });

  it("E0349: empty state string throws", () => {
    const node = parseTopList(
      '(type-state-binding (function "src/h.ts::H::f(1)") (param 0 state ""))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "non-empty string",
    });
  });

  it("E0349: missing 'state' keyword throws", () => {
    const node = parseTopList(
      '(type-state-binding (function "src/h.ts::H::f(1)") (param 0 status Submitted))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "keyword 'state'",
    });
  });

  it("E0349: unknown field throws", () => {
    const node = parseTopList(
      '(type-state-binding\n' +
        '  (function "src/h.ts::H::f(1)")\n' +
        '  (param 0 state Submitted)\n' +
        '  (mystery "x"))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: 'unknown field "mystery"',
    });
  });

  it("E0349: stray atom throws", () => {
    const node = parseTopList(
      '(type-state-binding "stray" (function "src/h.ts::H::f(1)") (param 0 state Submitted))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "unsupported entry",
    });
  });

  it("E0349: duplicate param index throws", () => {
    const node = parseTopList(
      '(type-state-binding\n' +
        '  (function "src/h.ts::H::f(2)")\n' +
        '  (param 0 state Submitted)\n' +
        '  (param 0 state Paid))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "more than once",
    });
  });

  it("E0349: malformed param (wrong arity) throws", () => {
    const node = parseTopList(
      '(type-state-binding (function "src/h.ts::H::f(1)") (param 0 state))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "expects 3 items",
    });
  });

  it("E0349: duplicate function clause throws", () => {
    const node = parseTopList(
      '(type-state-binding\n' +
        '  (function "src/h.ts::H::f(1)")\n' +
        '  (function "src/h.ts::H::g(1)")\n' +
        '  (param 0 state Submitted))',
    );
    expectSteleError(() => parseTypeStateBindingDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "function",
    });
  });
});
