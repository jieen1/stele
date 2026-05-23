import { describe, expect, it } from "vitest";

import {
  defaultFixHint,
  substituteFixHint,
} from "../src/fix-hint-substitution.js";
import { ALL_TRACE_VIOLATION_KINDS } from "../src/types.js";

describe("substituteFixHint — placeholders", () => {
  it("substitutes {predecessor}", () => {
    const out = substituteFixHint(
      "Insert `await {predecessor}()` first.",
      { predecessor: "permission.verify" },
    );
    expect(out).toBe("Insert `await permission.verify()` first.");
  });

  it("substitutes {target_call}", () => {
    const out = substituteFixHint(
      "Calling `{target_call}` is restricted.",
      { targetCall: "stripe.charges.create" },
    );
    expect(out).toBe("Calling `stripe.charges.create` is restricted.");
  });

  it("substitutes {actual_file}:{actual_line}", () => {
    const out = substituteFixHint(
      "Edit {actual_file}:{actual_line}.",
      { actualFile: "src/x.ts", actualLine: 42 },
    );
    expect(out).toBe("Edit src/x.ts:42.");
  });

  it("substitutes multiple placeholders in one template", () => {
    const out = substituteFixHint(
      "Insert `await {predecessor}({receiver_arg})` before `{target_call}` in {actual_file}:{actual_line}",
      {
        predecessor: "permission.verify",
        receiverArg: "orderId",
        targetCall: "stripe.charges.create",
        actualFile: "src/order.ts",
        actualLine: 17,
      },
    );
    expect(out).toBe(
      "Insert `await permission.verify(orderId)` before `stripe.charges.create` in src/order.ts:17",
    );
  });

  it("keeps unknown placeholders literally and warns once", () => {
    const warned: string[] = [];
    const out = substituteFixHint(
      "Edit `{whatzit}` and `{thingy}` and `{thingy}` again.",
      {},
      (p) => warned.push(p),
    );
    expect(out).toBe("Edit `{whatzit}` and `{thingy}` and `{thingy}` again.");
    // Only once per placeholder.
    expect(warned).toEqual(["whatzit", "thingy"]);
  });

  it("keeps backticks verbatim", () => {
    const out = substituteFixHint(
      "Use `Repository.find` not `Db.query`.",
      {},
    );
    expect(out).toBe("Use `Repository.find` not `Db.query`.");
  });

  it("empty template returns empty string", () => {
    expect(substituteFixHint("", {})).toBe("");
  });

  it("template with no placeholders passes through unchanged", () => {
    expect(substituteFixHint("plain text", { predecessor: "x" })).toBe("plain text");
  });

  it("supports both camelCase and snake_case placeholder names", () => {
    const ctx = { targetCall: "Foo.bar" };
    expect(substituteFixHint("{target_call}", ctx)).toBe("Foo.bar");
    expect(substituteFixHint("{targetCall}", ctx)).toBe("Foo.bar");
  });

  it("supports {forbidden_node} for deny-transit hints", () => {
    expect(
      substituteFixHint("Drop `{forbidden_node}` from the chain.", {
        forbiddenNode: "Cache.unsafe",
      }),
    ).toBe("Drop `Cache.unsafe` from the chain.");
  });
});

describe("defaultFixHint — generation", () => {
  it("returns sensible string for each TraceViolationKind", () => {
    const ctx = {
      actualFile: "src/x.ts",
      actualLine: 10,
      targetCall: "stripe.charge",
      predecessor: "permission.verify",
      successor: "audit.write",
      forbiddenNode: "Cache.unsafe",
    };
    for (const kind of ALL_TRACE_VIOLATION_KINDS) {
      const hint = defaultFixHint(kind, ctx);
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(0);
      // Per E0339 contract: must contain a backtick OR file:line.
      const hasBacktick = hint.includes("`");
      const hasFileLine = /\S:\d+/.test(hint);
      expect(hasBacktick || hasFileLine).toBe(true);
    }
  });

  it("missing_predecessor mentions the predecessor and target", () => {
    const out = defaultFixHint("missing_predecessor", {
      predecessor: "permission.verify",
      targetCall: "stripe.charge",
      actualFile: "src/x.ts",
      actualLine: 10,
    });
    expect(out).toContain("permission.verify");
    expect(out).toContain("stripe.charge");
    expect(out).toContain("src/x.ts:10");
  });

  it("forbidden_transit mentions the forbidden node", () => {
    const out = defaultFixHint("forbidden_transit", {
      forbiddenNode: "Cache.unsafe",
      targetCall: "Db.query",
      actualFile: "src/x.ts",
      actualLine: 5,
    });
    expect(out).toContain("Cache.unsafe");
  });

  it("falls back to <unknown> when file is absent", () => {
    const out = defaultFixHint("missing_transit", {
      targetCall: "Db.query",
    });
    expect(out).toContain("<unknown>");
  });

  // Maintainer's core design: fix-hint MUST force the agent into A/B branching
  // (code-issue vs contract-issue) before action. A naked code-change suggestion
  // pre-decides the answer is code-side and lets stale rules go unchallenged.
  describe("FIX_HINT_REQUIRES_ANALYSIS_BRANCH (every kind enforces A/B)", () => {
    for (const kind of ALL_TRACE_VIOLATION_KINDS) {
      it(`${kind}: contains code-issue + contract-issue + propose`, () => {
        const hint = defaultFixHint(kind, {
          actualFile: "src/x.ts",
          actualLine: 10,
          targetCall: "stripe.charge",
          predecessor: "permission.verify",
          successor: "audit.write",
          forbiddenNode: "Cache.unsafe",
        }, "PAYMENT_GUARD");
        expect(hint).toMatch(/\bcode\s+issue\b/i);
        expect(hint).toMatch(/\bcontract\s+issue\b/i);
        expect(hint).toMatch(/\bpropose\b/i);
        expect(hint).toMatch(/\[A\]/);
        expect(hint).toMatch(/\[B\]/);
      });
    }

    it("explicitly tells agent NOT to edit contract directly", () => {
      const hint = defaultFixHint("missing_predecessor", {
        actualFile: "src/x.ts",
        actualLine: 10,
        predecessor: "verify",
        targetCall: "charge",
      }, "RULE");
      expect(hint).toContain("Do NOT edit the contract");
    });

    it("references the policy id in the proposal guidance when provided", () => {
      const hint = defaultFixHint("missing_transit", {
        actualFile: "src/x.ts",
        actualLine: 10,
        targetCall: "Db.query",
      }, "DB_VIA_REPO");
      // Phase B currently exposes only `stele design propose <type>` with
      // built-in types invariant/branded-id/aggregate. Trace-policy-specific
      // propose subcommand is a planned follow-up — fix-hint instructs the
      // agent to write a YAML proposal containing the rule id instead.
      expect(hint).toContain("DB_VIA_REPO");
      expect(hint).toContain("stele design propose");
      expect(hint).toContain("contract/design/proposals/");
    });
  });
});
