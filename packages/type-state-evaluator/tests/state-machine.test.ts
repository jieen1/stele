import { describe, expect, it } from "vitest";

import {
  isTerminal,
  methodIsAllowedOp,
  methodIsTransition,
  methodTransitionsTo,
  reachableStates,
  unreachableStates,
} from "../src/state-machine.js";
import { mkTypeStateDecl } from "./fixtures/helpers.js";

const ORDER = mkTypeStateDecl({
  id: "ORDER_LIFECYCLE",
  target: "src/models/order.ts::Order",
  states: ["Draft", "Submitted", "Paid", "Shipped", "Cancelled", "Refunded", "Ghost"],
  initial: "Draft",
  terminal: ["Shipped", "Cancelled", "Refunded"],
  transitions: [
    { from: ["Draft"], via: "submit", to: "Submitted" },
    { from: ["Submitted"], via: "pay", to: "Paid" },
    { from: ["Submitted"], via: "cancel", to: "Cancelled" },
    { from: ["Paid"], via: "ship", to: "Shipped" },
    { from: ["Paid"], via: "refund", to: "Refunded" },
  ],
  allowedOps: {
    Draft: ["addItem", "removeItem", "submit"],
    Submitted: ["cancel", "pay"],
    Paid: ["ship", "refund"],
  },
});

describe("methodIsTransition", () => {
  it("returns true for declared transitions", () => {
    expect(methodIsTransition(ORDER, "Draft", "submit")).toBe(true);
    expect(methodIsTransition(ORDER, "Paid", "ship")).toBe(true);
  });

  it("returns false when method is not the via", () => {
    expect(methodIsTransition(ORDER, "Draft", "pay")).toBe(false);
    expect(methodIsTransition(ORDER, "Paid", "submit")).toBe(false);
  });

  it("returns false when from-state does not list the source", () => {
    expect(methodIsTransition(ORDER, "Shipped", "ship")).toBe(false);
    expect(methodIsTransition(ORDER, "Cancelled", "cancel")).toBe(false);
  });

  it("supports multi-source transitions (Round 1 N-4 sugar)", () => {
    const multi = mkTypeStateDecl({
      id: "M",
      target: "src/m.ts::M",
      states: ["A", "B", "C", "Cancelled"],
      initial: "A",
      terminal: ["Cancelled"],
      transitions: [{ from: ["A", "B", "C"], via: "cancel", to: "Cancelled" }],
    });
    expect(methodIsTransition(multi, "A", "cancel")).toBe(true);
    expect(methodIsTransition(multi, "B", "cancel")).toBe(true);
    expect(methodIsTransition(multi, "C", "cancel")).toBe(true);
    expect(methodIsTransition(multi, "Cancelled", "cancel")).toBe(false);
  });
});

describe("methodTransitionsTo", () => {
  it("returns destination state for a matching transition", () => {
    expect(methodTransitionsTo(ORDER, "Draft", "submit")).toBe("Submitted");
    expect(methodTransitionsTo(ORDER, "Paid", "ship")).toBe("Shipped");
  });

  it("returns null when no transition matches", () => {
    expect(methodTransitionsTo(ORDER, "Draft", "ship")).toBeNull();
    expect(methodTransitionsTo(ORDER, "Paid", "addItem")).toBeNull();
  });
});

describe("methodIsAllowedOp", () => {
  it("returns true for explicitly allowed ops", () => {
    expect(methodIsAllowedOp(ORDER, "Draft", "addItem")).toBe(true);
    expect(methodIsAllowedOp(ORDER, "Submitted", "cancel")).toBe(true);
  });

  it("returns false when method not in allowed list", () => {
    expect(methodIsAllowedOp(ORDER, "Paid", "addItem")).toBe(false);
    expect(methodIsAllowedOp(ORDER, "Draft", "ship")).toBe(false);
  });

  it("returns false for states with no allowed-ops entry", () => {
    expect(methodIsAllowedOp(ORDER, "Shipped", "anything")).toBe(false);
    expect(methodIsAllowedOp(ORDER, "Ghost", "addItem")).toBe(false);
  });
});

describe("isTerminal", () => {
  it("returns true for terminal states", () => {
    expect(isTerminal(ORDER, "Shipped")).toBe(true);
    expect(isTerminal(ORDER, "Cancelled")).toBe(true);
    expect(isTerminal(ORDER, "Refunded")).toBe(true);
  });

  it("returns false for non-terminal states", () => {
    expect(isTerminal(ORDER, "Draft")).toBe(false);
    expect(isTerminal(ORDER, "Submitted")).toBe(false);
    expect(isTerminal(ORDER, "Paid")).toBe(false);
  });

  // Round 4 P2-6: terminal-state any-method-call rejection. Previously
  // this signal was only exercised through extractor-driven fixture
  // `05-terminal-state-violation`. If the extractor mis-infers, the
  // invariant is lost. Pin it as a focused unit test that bypasses the
  // extractor entirely: any method call on a node inferred at a terminal
  // state must be disallowed by methodIsAllowedOp + methodIsTransition.
  it("rejects every method call when the inferred state is terminal (P2-6)", () => {
    for (const terminalState of ["Shipped", "Cancelled", "Refunded"]) {
      expect(isTerminal(ORDER, terminalState)).toBe(true);
      // No allowed-ops mapping is declared for terminal states in the
      // fixture; any method must therefore be disallowed.
      for (const method of ["ship", "cancel", "addItem", "refund", "pay"]) {
        expect(methodIsAllowedOp(ORDER, terminalState, method)).toBe(false);
        // Transitions out of a terminal state are also disallowed by design.
        expect(methodIsTransition(ORDER, terminalState, method)).toBe(false);
      }
    }
  });
});

describe("reachableStates", () => {
  it("includes the initial state", () => {
    const r = reachableStates(ORDER);
    expect(r.has("Draft")).toBe(true);
  });

  it("computes the full reachable set via transitions", () => {
    const r = reachableStates(ORDER);
    expect(r.has("Submitted")).toBe(true);
    expect(r.has("Paid")).toBe(true);
    expect(r.has("Shipped")).toBe(true);
    expect(r.has("Cancelled")).toBe(true);
    expect(r.has("Refunded")).toBe(true);
  });

  it("excludes unreachable states", () => {
    const r = reachableStates(ORDER);
    expect(r.has("Ghost")).toBe(false);
  });
});

describe("unreachableStates", () => {
  it("reports states declared but not reached from initial", () => {
    expect(unreachableStates(ORDER)).toEqual(["Ghost"]);
  });

  it("returns empty when every state is reachable", () => {
    const fully = mkTypeStateDecl({
      id: "FULLY_REACHABLE",
      target: "src/x.ts::X",
      states: ["A", "B"],
      initial: "A",
      terminal: ["B"],
      transitions: [{ from: ["A"], via: "go", to: "B" }],
    });
    expect(unreachableStates(fully)).toEqual([]);
  });
});
