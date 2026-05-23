import { describe, expect, it } from "vitest";
import type { ListNode } from "../src/index";
import { SteleError, parseFile } from "../src/index";
import {
  parseTypeStateDeclaration,
  type TypeStateDeclaration,
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

function parseTS(source: string): TypeStateDeclaration {
  return parseTypeStateDeclaration(FILE_PATH, parseTopList(source));
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

describe("parseTypeStateDeclaration — happy path", () => {
  it("parses a minimal valid type-state", () => {
    const ts = parseTS(
      '(type-state ORDER\n' +
        '  (target "src/order.ts::Order")\n' +
        '  (states Draft Submitted)\n' +
        '  (initial Draft)\n' +
        '  (transition (from Draft) (via submit) (to Submitted)))',
    );
    expect(ts.kind).toBe("type-state");
    expect(ts.id).toBe("ORDER");
    expect(ts.target).toBe("src/order.ts::Order");
    expect(ts.states).toEqual(["Draft", "Submitted"]);
    expect(ts.initial).toBe("Draft");
    expect(ts.terminal).toEqual([]);
    expect(ts.severity).toBe("error");
    expect(ts.transitions).toHaveLength(1);
    expect(ts.transitions[0]?.from).toEqual(["Draft"]);
    expect(ts.transitions[0]?.via).toBe("submit");
    expect(ts.transitions[0]?.to).toBe("Submitted");
    expect(ts.allowedOps.size).toBe(0);
    expect(ts.stateTypeMapping).toEqual([]);
    expect(ts.filePath).toBe(FILE_PATH);
  });

  it("parses a full type-state with every field populated", () => {
    const ts = parseTS(
      '(type-state ORDER_LIFECYCLE\n' +
        '  (description "Order can only transition through declared states.")\n' +
        '  (severity "warning")\n' +
        '  (target "src/models/order.ts::Order")\n' +
        '  (states Draft Submitted Paid Shipped Cancelled)\n' +
        '  (initial Draft)\n' +
        '  (terminal Shipped Cancelled)\n' +
        '  (transition (from Draft)     (via submit)  (to Submitted))\n' +
        '  (transition (from Submitted) (via pay)     (to Paid))\n' +
        '  (transition (from Submitted) (via cancel)  (to Cancelled))\n' +
        '  (transition (from Paid)      (via ship)    (to Shipped))\n' +
        '  (allowed-ops Draft addItem removeItem submit)\n' +
        '  (allowed-ops Submitted cancel pay)\n' +
        '  (allowed-ops Paid ship)\n' +
        '  (fix-hint "Check the order state before invoking `Order.addItem`."))',
    );
    expect(ts.id).toBe("ORDER_LIFECYCLE");
    expect(ts.description).toBe("Order can only transition through declared states.");
    expect(ts.severity).toBe("warning");
    expect(ts.target).toBe("src/models/order.ts::Order");
    expect(ts.states).toEqual(["Draft", "Submitted", "Paid", "Shipped", "Cancelled"]);
    expect(ts.initial).toBe("Draft");
    expect(ts.terminal).toEqual(["Shipped", "Cancelled"]);
    expect(ts.transitions).toHaveLength(4);
    expect(ts.allowedOps.get("Draft")).toEqual(["addItem", "removeItem", "submit"]);
    expect(ts.allowedOps.get("Submitted")).toEqual(["cancel", "pay"]);
    expect(ts.allowedOps.get("Paid")).toEqual(["ship"]);
    expect(ts.fixHint).toBe("Check the order state before invoking `Order.addItem`.");
  });

  it("accepts target as a single path::TypeName value", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/order.ts::Order")\n' +
        '  (states Draft) (initial Draft))',
    );
    expect(ts.target).toBe("src/order.ts::Order");
  });

  it("accepts target as a NodeId glob (Go separate-types case)", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/order/**::*Order")\n' +
        '  (states Draft) (initial Draft))',
    );
    expect(ts.target).toBe("src/order/**::*Order");
  });

  it("expands multi-source transition (from A B) into preserved from-list (N-4)", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/order.ts::Order")\n' +
        '  (states Draft Submitted Cancelled)\n' +
        '  (initial Draft)\n' +
        '  (transition (from Draft Submitted) (via cancel) (to Cancelled)))',
    );
    expect(ts.transitions).toHaveLength(1);
    expect(ts.transitions[0]?.from).toEqual(["Draft", "Submitted"]);
    expect(ts.transitions[0]?.via).toBe("cancel");
    expect(ts.transitions[0]?.to).toBe("Cancelled");
  });

  it("accepts terminal states", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/order.ts::Order")\n' +
        '  (states Draft Paid Shipped)\n' +
        '  (initial Draft)\n' +
        '  (terminal Shipped)\n' +
        '  (transition (from Draft) (via pay) (to Paid))\n' +
        '  (transition (from Paid) (via ship) (to Shipped)))',
    );
    expect(ts.terminal).toEqual(["Shipped"]);
  });

  it("accepts state-type-mapping (Go separate-types)", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/order/**::*Order")\n' +
        '  (state-type-mapping\n' +
        '    Draft "src/order/draft.go::DraftOrder"\n' +
        '    Submitted "src/order/submitted.go::SubmittedOrder")\n' +
        '  (states Draft Submitted)\n' +
        '  (initial Draft))',
    );
    expect(ts.stateTypeMapping).toHaveLength(2);
    expect(ts.stateTypeMapping[0]).toMatchObject({ state: "Draft", target: "src/order/draft.go::DraftOrder" });
    expect(ts.stateTypeMapping[1]).toMatchObject({ state: "Submitted", target: "src/order/submitted.go::SubmittedOrder" });
  });

  it("accepts allowed-ops per state", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/order.ts::Order")\n' +
        '  (states Draft Submitted)\n' +
        '  (initial Draft)\n' +
        '  (allowed-ops Draft addItem removeItem)\n' +
        '  (allowed-ops Submitted cancel))',
    );
    expect(ts.allowedOps.get("Draft")).toEqual(["addItem", "removeItem"]);
    expect(ts.allowedOps.get("Submitted")).toEqual(["cancel"]);
  });

  it("severity defaults to error", () => {
    const ts = parseTS(
      '(type-state O (target "src/o.ts::O") (states A) (initial A))',
    );
    expect(ts.severity).toBe("error");
  });

  it("severity warning is preserved", () => {
    const ts = parseTS(
      '(type-state O (severity "warning") (target "src/o.ts::O") (states A) (initial A))',
    );
    expect(ts.severity).toBe("warning");
  });

  it("accepts a fix-hint with backtick-quoted code", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A) (initial A)\n' +
        '  (fix-hint "use `Order.submit` first"))',
    );
    expect(ts.fixHint).toBe("use `Order.submit` first");
  });

  it("accepts a fix-hint with file:line reference", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A) (initial A)\n' +
        '  (fix-hint "see src/order.ts:42 for the helper"))',
    );
    expect(ts.fixHint).toBe("see src/order.ts:42 for the helper");
  });
});

describe("parseTypeStateDeclaration — error paths", () => {
  it("E0340: missing id throws", () => {
    const node = parseTopList('(type-state (target "src/o.ts::O") (states A) (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0340",
      messageIncludes: "must start with",
    });
  });

  it("E0342: missing target throws", () => {
    const node = parseTopList('(type-state O (states A) (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: "must declare a (target",
    });
  });

  it("E0342: empty target string throws", () => {
    const node = parseTopList('(type-state O (target "") (states A) (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: "non-empty string",
    });
  });

  it("E0342: target without `::` separator throws", () => {
    const node = parseTopList('(type-state O (target "src/o.ts") (states A) (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: "<path>::<TypeName>",
    });
  });

  it("E0342: trailing `::` throws", () => {
    const node = parseTopList('(type-state O (target "src/o.ts::") (states A) (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: 'trailing "::"',
    });
  });

  it("E0342: target as non-string throws", () => {
    const node = parseTopList('(type-state O (target 42) (states A) (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: "string literal",
    });
  });

  it("E0343: empty states throws", () => {
    const node = parseTopList('(type-state O (target "src/o.ts::O") (states) (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0343",
      messageIncludes: "at least one state",
    });
  });

  it("E0343: no states clause at all throws", () => {
    const node = parseTopList('(type-state O (target "src/o.ts::O") (initial A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0343",
      messageIncludes: "(states ...)",
    });
  });

  it("E0344: initial not in states throws", () => {
    const node = parseTopList(
      '(type-state O (target "src/o.ts::O") (states A B) (initial C))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0344",
      messageIncludes: "initial state",
    });
  });

  it("E0344: missing initial throws", () => {
    const node = parseTopList('(type-state O (target "src/o.ts::O") (states A))');
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0344",
      messageIncludes: "(initial",
    });
  });

  it("E0345: terminal contains non-state throws", () => {
    const node = parseTopList(
      '(type-state O (target "src/o.ts::O") (states A B) (initial A) (terminal Z))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0345",
      messageIncludes: "terminal contains non-state",
    });
  });

  it("E0346: transition.from non-state throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A B)\n' +
        '  (initial A)\n' +
        '  (transition (from Z) (via go) (to B)))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0346",
      messageIncludes: 'transition.from contains non-state "Z"',
    });
  });

  it("E0346: transition.to non-state throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A B)\n' +
        '  (initial A)\n' +
        '  (transition (from A) (via go) (to Z)))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0346",
      messageIncludes: 'transition.to "Z"',
    });
  });

  it("E0347: allowed-ops state non-state throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A)\n' +
        '  (initial A)\n' +
        '  (allowed-ops Z method))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0347",
      messageIncludes: "references a state not in",
    });
  });

  it("E0348: terminal in transition.from throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A B)\n' +
        '  (initial A)\n' +
        '  (terminal B)\n' +
        '  (transition (from B) (via go) (to A)))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0348",
      messageIncludes: "terminal state",
    });
  });

  it("E0349: unknown field throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A)\n' +
        '  (initial A)\n' +
        '  (mystery "x"))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: 'unknown field "mystery"',
    });
  });

  it("E0349: vague fix-hint throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A)\n' +
        '  (initial A)\n' +
        '  (fix-hint "must do better"))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "vague",
    });
  });

  it("E0349: invalid severity throws", () => {
    const node = parseTopList(
      '(type-state O (severity "info") (target "src/o.ts::O") (states A) (initial A))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: 'severity must be',
    });
  });

  it("E0349: stray atom inside type-state body throws", () => {
    const node = parseTopList(
      '(type-state O "stray" (target "src/o.ts::O") (states A) (initial A))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "unsupported entry",
    });
  });

  it("E0349: duplicate target clause throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (target "src/o2.ts::O")\n' +
        '  (states A) (initial A))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "target",
    });
  });

  it("E0349: duplicate allowed-ops for same state throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A)\n' +
        '  (initial A)\n' +
        '  (allowed-ops A m1)\n' +
        '  (allowed-ops A m2))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0349",
      messageIncludes: "more than once",
    });
  });
});

describe("parseTypeStateDeclaration — pattern integration / target validation", () => {
  it("accepts a glob target with `*` wildcard", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/order/*.go::*Order")\n' +
        '  (states A) (initial A))',
    );
    expect(ts.target).toBe("src/order/*.go::*Order");
  });

  it("accepts a glob target with `**` recursion", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/**::Order")\n' +
        '  (states A) (initial A))',
    );
    expect(ts.target).toBe("src/**::Order");
  });

  it("accepts a glob target with brace expansion", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/**/*.{ts,py}::Order")\n' +
        '  (states A) (initial A))',
    );
    expect(ts.target).toBe("src/**/*.{ts,py}::Order");
  });

  it("E0342: whitespace-only target throws", () => {
    const node = parseTopList(
      '(type-state O (target "   ") (states A) (initial A))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: "non-empty string",
    });
  });

  it("E0342: state-type-mapping with odd number of items throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/order/**::*Order")\n' +
        '  (state-type-mapping Draft "src/order/draft.go::DraftOrder" Submitted)\n' +
        '  (states Draft Submitted) (initial Draft))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: "pairs of",
    });
  });

  it("E0342: state-type-mapping target with trailing :: throws", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/order/**::*Order")\n' +
        '  (state-type-mapping Draft "src/order/draft.go::")\n' +
        '  (states Draft) (initial Draft))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0342",
      messageIncludes: 'trailing "::"',
    });
  });
});

describe("parseTypeStateDeclaration — multi-source transition (Round 1 N-4)", () => {
  it("(from A B) expands correctly", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A B C)\n' +
        '  (initial A)\n' +
        '  (transition (from A B) (via go) (to C)))',
    );
    expect(ts.transitions[0]?.from).toEqual(["A", "B"]);
  });

  it("(from A) single-value still works", () => {
    const ts = parseTS(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A B)\n' +
        '  (initial A)\n' +
        '  (transition (from A) (via go) (to B)))',
    );
    expect(ts.transitions[0]?.from).toEqual(["A"]);
  });

  it("multi-source with one non-state in from list throws E0346", () => {
    const node = parseTopList(
      '(type-state O\n' +
        '  (target "src/o.ts::O")\n' +
        '  (states A B C)\n' +
        '  (initial A)\n' +
        '  (transition (from A Z) (via go) (to C)))',
    );
    expectSteleError(() => parseTypeStateDeclaration(FILE_PATH, node), {
      code: "E0346",
      messageIncludes: 'non-state "Z"',
    });
  });
});

describe("integration with the top-level parser", () => {
  it("parses type-state alongside other top-level forms", () => {
    const source =
      '(type-state A (target "src/a.ts::A") (states X) (initial X))\n' +
      '(type-state B (target "src/b.ts::B") (states Y) (initial Y))\n';
    const parsed = parseFile(source, FILE_PATH);
    expect(parsed.body).toHaveLength(2);
    expect((parsed.body[0] as ListNode).head).toBe("type-state");
    expect((parsed.body[1] as ListNode).head).toBe("type-state");
  });
});
