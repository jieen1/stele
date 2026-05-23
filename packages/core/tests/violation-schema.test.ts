import { describe, expect, it } from "vitest";
import {
  compareViolationsByPriority,
  createViolation,
  priorityRank,
  severityRank,
  sortViolations,
  type Violation,
  type ViolationInput,
} from "../src/index.js";

function baseInput(overrides: Partial<ViolationInput> = {}): ViolationInput {
  return {
    rule_id: "typedriven.branded-id.OrderId",
    rule_kind: "typescript-branded-id",
    severity: "error",
    source: { tool: "stele", command: "check", kind: "rule" },
    location: { path: "src/a.ts", line: 1, column: 1 },
    cause: { summary: "test" },
    scope_paths: ["src/a.ts"],
    ...overrides,
  };
}

function violation(overrides: Partial<ViolationInput> = {}): Violation {
  return createViolation(baseInput(overrides));
}

describe("Violation schema — Phase B Round 2 additions", () => {
  it("back-compat: a Phase-A-shape Violation literal still satisfies the type", () => {
    const v: Violation = {
      rule_id: "typedriven.branded-id.OrderId",
      rule_kind: "typescript-branded-id",
      severity: "error",
      source: { tool: "stele", command: "check", kind: "rule" },
      location: { path: "src/a.ts" },
      cause: { summary: "x" },
      fingerprint: "abc",
      scope_paths: ["src/a.ts"],
    };
    expect(v.priority).toBeUndefined();
    expect(v.group_id).toBeUndefined();
    expect(v.also_violates).toBeUndefined();
    expect(v.resolves_with).toBeUndefined();
    expect(v.cross_rule_note).toBeUndefined();
  });

  it("createViolation accepts the new optional fields and preserves them", () => {
    const v = violation({
      priority: "blocking",
      group_id: "src/a.ts::Foo::bar",
      also_violates: ["trace.X.missing_predecessor"],
      resolves_with: ["effect.Y.forbidden_effect"],
      cross_rule_note: "moving this code will not resolve trace.*",
    });
    expect(v.priority).toBe("blocking");
    expect(v.group_id).toBe("src/a.ts::Foo::bar");
    expect(v.also_violates).toEqual(["trace.X.missing_predecessor"]);
    expect(v.resolves_with).toEqual(["effect.Y.forbidden_effect"]);
    expect(v.cross_rule_note).toBe("moving this code will not resolve trace.*");
  });

  it("createViolation defensively clones the new arrays", () => {
    const also = ["trace.X.missing_predecessor"];
    const resolves = ["effect.Y.forbidden_effect"];
    const v = violation({ also_violates: also, resolves_with: resolves });
    expect(v.also_violates).not.toBe(also);
    expect(v.resolves_with).not.toBe(resolves);
    expect(v.also_violates).toEqual(also);
    expect(v.resolves_with).toEqual(resolves);
  });

  it("fingerprint does not depend on the new fields (baseline stability)", () => {
    const a = violation();
    const b = violation({
      priority: "minor",
      group_id: "g",
      also_violates: ["x"],
      resolves_with: ["y"],
      cross_rule_note: "note",
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("priorityRank", () => {
  it("returns 0 for blocking", () => {
    expect(priorityRank(violation({ priority: "blocking" }))).toBe(0);
  });
  it("returns 1 for major (and the default when omitted)", () => {
    expect(priorityRank(violation({ priority: "major" }))).toBe(1);
    expect(priorityRank(violation())).toBe(1);
  });
  it("returns 2 for minor", () => {
    expect(priorityRank(violation({ priority: "minor" }))).toBe(2);
  });
});

describe("severityRank", () => {
  it("returns 0 for error", () => {
    expect(severityRank(violation({ severity: "error" }))).toBe(0);
  });
  it("returns 1 for warning", () => {
    expect(severityRank(violation({ severity: "warning" }))).toBe(1);
  });
  it("returns 2 for info", () => {
    expect(severityRank(violation({ severity: "info" }))).toBe(2);
  });
  it("returns 2 for the forward-compat alias 'notice'", () => {
    // Round 2 spec also mentions "notice"; severity field is typed but the
    // map is keyed by string so unknown ranks compare predictably.
    const v: Violation = { ...violation(), severity: "notice" as unknown as Violation["severity"] };
    expect(severityRank(v)).toBe(2);
  });
  it("returns 99 for an unknown severity", () => {
    const v: Violation = { ...violation(), severity: "bogus" as unknown as Violation["severity"] };
    expect(severityRank(v)).toBe(99);
  });
});

describe("compareViolationsByPriority", () => {
  it("orders blocking before major before minor", () => {
    const blocking = violation({ priority: "blocking" });
    const major = violation({ priority: "major" });
    const minor = violation({ priority: "minor" });
    expect(compareViolationsByPriority(blocking, major)).toBeLessThan(0);
    expect(compareViolationsByPriority(major, minor)).toBeLessThan(0);
    expect(compareViolationsByPriority(minor, blocking)).toBeGreaterThan(0);
  });

  it("ties on priority break by group_id (alphabetical)", () => {
    const a = violation({ priority: "major", group_id: "alpha" });
    const b = violation({ priority: "major", group_id: "beta" });
    expect(compareViolationsByPriority(a, b)).toBeLessThan(0);
    expect(compareViolationsByPriority(b, a)).toBeGreaterThan(0);
  });

  it("treats missing group_id as empty string (sorts first)", () => {
    const blank = violation({ priority: "major" });
    const named = violation({ priority: "major", group_id: "alpha" });
    expect(compareViolationsByPriority(blank, named)).toBeLessThan(0);
  });

  it("ties on priority + group break by severity (error → warning → info)", () => {
    const err = violation({ priority: "major", group_id: "g", severity: "error" });
    const warn = violation({ priority: "major", group_id: "g", severity: "warning" });
    const info = violation({ priority: "major", group_id: "g", severity: "info" });
    expect(compareViolationsByPriority(err, warn)).toBeLessThan(0);
    expect(compareViolationsByPriority(warn, info)).toBeLessThan(0);
    expect(compareViolationsByPriority(err, info)).toBeLessThan(0);
  });

  it("ties on priority + group + severity break by location.path", () => {
    const a = violation({ priority: "major", group_id: "g", location: { path: "src/a.ts", line: 1, column: 1 } });
    const b = violation({ priority: "major", group_id: "g", location: { path: "src/b.ts", line: 1, column: 1 } });
    expect(compareViolationsByPriority(a, b)).toBeLessThan(0);
  });

  it("ties on path break by line, then column", () => {
    const l1 = violation({ priority: "major", group_id: "g", location: { path: "src/a.ts", line: 1, column: 5 } });
    const l2 = violation({ priority: "major", group_id: "g", location: { path: "src/a.ts", line: 2, column: 1 } });
    const c5 = violation({ priority: "major", group_id: "g", location: { path: "src/a.ts", line: 1, column: 5 } });
    const c1 = violation({ priority: "major", group_id: "g", location: { path: "src/a.ts", line: 1, column: 1 } });
    expect(compareViolationsByPriority(l1, l2)).toBeLessThan(0);
    expect(compareViolationsByPriority(c1, c5)).toBeLessThan(0);
  });

  it("returns 0 for two identical violations", () => {
    const a = violation({ priority: "major", group_id: "g" });
    const b = violation({ priority: "major", group_id: "g" });
    expect(compareViolationsByPriority(a, b)).toBe(0);
  });
});

describe("sortViolations", () => {
  it("returns an empty array for an empty input", () => {
    expect(sortViolations([])).toEqual([]);
  });

  it("is pure — does not mutate input", () => {
    const input = [
      violation({ priority: "minor", group_id: "z" }),
      violation({ priority: "blocking", group_id: "a" }),
      violation({ priority: "major", group_id: "m" }),
    ];
    const snapshot = input.map((v) => v.priority);
    const sorted = sortViolations(input);
    expect(input.map((v) => v.priority)).toEqual(snapshot);
    expect(sorted).not.toBe(input);
    expect(sorted.map((v) => v.priority)).toEqual(["blocking", "major", "minor"]);
  });

  it("sorts a mixed list end-to-end through every tiebreaker", () => {
    const items = [
      violation({
        priority: "major",
        group_id: "g2",
        severity: "warning",
        location: { path: "src/b.ts", line: 10, column: 1 },
      }),
      violation({
        priority: "blocking",
        group_id: "g1",
        severity: "error",
        location: { path: "src/a.ts", line: 1, column: 1 },
      }),
      violation({
        priority: "major",
        group_id: "g2",
        severity: "error",
        location: { path: "src/b.ts", line: 5, column: 1 },
      }),
      violation({
        priority: "minor",
        group_id: "g3",
        severity: "info",
        location: { path: "src/c.ts", line: 1, column: 1 },
      }),
      violation({
        priority: "major",
        group_id: "g2",
        severity: "error",
        location: { path: "src/b.ts", line: 5, column: 4 },
      }),
    ];
    const sorted = sortViolations(items);
    expect(sorted.map((v) => v.priority)).toEqual(["blocking", "major", "major", "major", "minor"]);
    // among the three "major" items, group_id is the same so severity decides; error before warning
    expect(sorted[1].severity).toBe("error");
    expect(sorted[2].severity).toBe("error");
    expect(sorted[3].severity).toBe("warning");
    // among the two error/major/g2/src/b.ts entries, line then column decides
    expect(sorted[1].location).toEqual({ path: "src/b.ts", line: 5, column: 1 });
    expect(sorted[2].location).toEqual({ path: "src/b.ts", line: 5, column: 4 });
  });
});
