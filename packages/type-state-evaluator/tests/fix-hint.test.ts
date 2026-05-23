import { describe, expect, it } from "vitest";

import {
  defaultDisallowedOpFixHint,
  defaultInferenceFailedFixHint,
  proposeExitText,
} from "../src/fix-hint.js";
import { mkTypeStateDecl } from "./fixtures/helpers.js";

const ORDER = mkTypeStateDecl({
  id: "ORDER_LIFECYCLE",
  target: "src/models/order.ts::Order",
  states: ["Draft", "Submitted", "Paid"],
  initial: "Draft",
  transitions: [
    { from: ["Draft"], via: "submit", to: "Submitted" },
    { from: ["Submitted"], via: "pay", to: "Paid" },
  ],
  allowedOps: {
    Draft: ["addItem", "submit"],
    Submitted: ["pay", "cancel"],
    Paid: ["ship", "refund"],
  },
});

describe("defaultDisallowedOpFixHint", () => {
  const hint = defaultDisallowedOpFixHint(
    ORDER,
    "Paid",
    "addItem",
    "src/services/order.ts",
    74,
  );

  it("contains a backtick-quoted code snippet (E0339 actionable)", () => {
    expect(hint).toContain("`addItem`");
    expect(hint).toContain("`Paid`");
  });

  it("references the rule id in the proposal guidance", () => {
    // Phase B currently exposes only `stele design propose <type>` with
    // built-in types invariant/branded-id/aggregate. Type-state-specific
    // propose subcommand is a planned follow-up — fix-hint instructs the
    // agent to write a YAML proposal containing the rule id instead.
    expect(hint).toContain("ORDER_LIFECYCLE");
    expect(hint).toContain("stele design propose");
    expect(hint).toContain("contract/design/proposals/");
  });

  it("references the call site file:line", () => {
    expect(hint).toContain("src/services/order.ts:74");
  });

  it("Round 1 MC-15 — does NOT instruct agent to edit contract directly", () => {
    // The propose-exit phrase asserts NEGATIVE behaviour: it tells the agent
    // not to edit. The check below enforces the absence of any
    // "edit the contract" instruction (without the surrounding 'NOT' qualifier
    // we always emit). We search for affirmative-edit phrases.
    expect(hint).not.toMatch(/\bedit\s+(the\s+)?contract\s+(file\s+)?directly\b(?!\s*[—-])/i);
    expect(hint).not.toContain("Modify ORDER_LIFECYCLE.allowed-ops");
    expect(hint).not.toContain("Edit the (type-state ...) form");
    // Must contain the explicit NOT-edit phrasing.
    expect(hint).toContain("Do NOT edit the contract directly");
  });

  it("contains the word 'rationale' or 'research'", () => {
    expect(hint).toMatch(/rationale|research/);
  });

  it("includes the propose-exit text verbatim", () => {
    expect(hint).toContain(proposeExitText(ORDER.id));
  });

  // Maintainer's core design: fix-hint MUST force the agent into A/B branching
  // before action. A naked "Insert X" pre-decides the answer is code-side.
  // The hint must contain BOTH the code-issue branch and the contract-issue branch
  // so the agent must explicitly pick one.
  it("forces A/B analysis branch (FIX_HINT_REQUIRES_ANALYSIS_BRANCH)", () => {
    expect(hint).toMatch(/\bcode\s+issue\b/i);
    expect(hint).toMatch(/\bcontract\s+issue\b/i);
    expect(hint).toMatch(/\bpropose\b/i);
    // The hint must explicitly enumerate both options [A] and [B]
    expect(hint).toMatch(/\[A\]/);
    expect(hint).toMatch(/\[B\]/);
  });
});

describe("defaultInferenceFailedFixHint", () => {
  const hint = defaultInferenceFailedFixHint(
    ORDER,
    "src/services/order.ts::OrderService::process(1)",
  );

  it("suggests adding (type-state-binding ...)", () => {
    expect(hint).toContain("(type-state-binding");
    expect(hint).toContain("(param 0 state");
  });

  it("references the offending caller NodeId", () => {
    expect(hint).toContain("src/services/order.ts::OrderService::process(1)");
  });

  it("Round 1 MC-15 — does NOT instruct agent to edit contract directly", () => {
    expect(hint).not.toMatch(/\bedit\s+(the\s+)?contract\s+(file\s+)?directly\b(?!\s*[—-])/i);
    expect(hint).toContain("Do NOT edit the contract directly");
  });

  it("references the rule id and proposal flow", () => {
    expect(hint).toContain("ORDER_LIFECYCLE");
    expect(hint).toContain("stele design propose");
    expect(hint).toContain("contract/design/proposals/");
  });

  it("forces A/B analysis branch (FIX_HINT_REQUIRES_ANALYSIS_BRANCH)", () => {
    expect(hint).toMatch(/\bcode\s+issue\b/i);
    expect(hint).toMatch(/\bcontract\s+issue\b/i);
    expect(hint).toMatch(/\bpropose\b/i);
    expect(hint).toMatch(/\[A\]/);
    expect(hint).toMatch(/\[B\]/);
  });
});

describe("proposeExitText", () => {
  it("is parameterised by declaration id", () => {
    const a = proposeExitText("RULE_A");
    const b = proposeExitText("RULE_B");
    expect(a).toContain("RULE_A");
    expect(b).toContain("RULE_B");
    expect(a).not.toContain("RULE_B");
  });

  it("contains the 'Do NOT edit the contract directly' clause", () => {
    expect(proposeExitText("X")).toContain("Do NOT edit the contract directly");
  });
});
