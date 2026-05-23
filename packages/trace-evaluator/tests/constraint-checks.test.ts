import { describe, expect, it } from "vitest";

import { compilePattern } from "@stele/call-graph-core";

import {
  checkDenyDirect,
  checkDenyTransit,
  checkMustBeFollowedBy,
  checkMustBePrecededBy,
  checkMustTransit,
} from "../src/constraint-checks.js";
import type { EnumeratedPath } from "../src/path-enumeration.js";

function path(nodes: readonly string[]): EnumeratedPath {
  return { nodes };
}

describe("checkMustTransit", () => {
  it("passes when intermediate matches", () => {
    const p = path([
      "src/c.ts::Controller::handle(0)",
      "src/r.ts::Repository::find(1)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**::Repository::*")];
    expect(checkMustTransit(p, patterns)).toBe(false);
  });

  it("fails when no intermediate matches", () => {
    const p = path([
      "src/c.ts::Controller::handle(0)",
      "src/s.ts::Service::find(1)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**::Repository::*")];
    expect(checkMustTransit(p, patterns)).toBe(true);
  });

  it("fails on a direct (length-2) path", () => {
    const p = path([
      "src/c.ts::Controller::handle(0)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**::Repository::*")];
    expect(checkMustTransit(p, patterns)).toBe(true);
  });

  it("returns false when no patterns supplied", () => {
    const p = path([
      "src/c.ts::A(0)",
      "src/d.ts::B(0)",
    ]);
    expect(checkMustTransit(p, [])).toBe(false);
  });

  it("matches with extern: pattern", () => {
    const p = path([
      "src/x.ts::Pay(0)",
      "extern:stripe::Charges::create(2)",
    ]);
    const patterns = [compilePattern("extern:stripe::*")];
    // Direct call to target — no intermediates, so must-transit fails.
    expect(checkMustTransit(p, patterns)).toBe(true);
  });
});

describe("checkDenyDirect", () => {
  it("flags direct call from matching caller", () => {
    const p = path([
      "src/controllers/order.ts::handle(0)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**/controllers/**::*")];
    expect(checkDenyDirect(p, p.nodes[0]!, patterns)).toBe(true);
  });

  it("does not flag indirect call", () => {
    const p = path([
      "src/controllers/order.ts::handle(0)",
      "src/services/order.ts::run(0)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**/controllers/**::*")];
    expect(checkDenyDirect(p, p.nodes[0]!, patterns)).toBe(false);
  });

  it("does not flag caller not matching pattern", () => {
    const p = path([
      "src/util.ts::helper(0)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**/controllers/**::*")];
    expect(checkDenyDirect(p, p.nodes[0]!, patterns)).toBe(false);
  });

  it("returns false on empty patterns", () => {
    const p = path([
      "src/x.ts::A(0)",
      "src/y.ts::B(0)",
    ]);
    expect(checkDenyDirect(p, p.nodes[0]!, [])).toBe(false);
  });
});

describe("checkDenyTransit", () => {
  it("flags forbidden intermediate node", () => {
    const p = path([
      "src/a.ts::A(0)",
      "src/cache.ts::CacheUnsafe::write(0)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**::CacheUnsafe::*")];
    expect(checkDenyTransit(p, patterns)).toBe("src/cache.ts::CacheUnsafe::write(0)");
  });

  it("returns null when no intermediate matches", () => {
    const p = path([
      "src/a.ts::A(0)",
      "src/r.ts::Repository::find(1)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**::CacheUnsafe::*")];
    expect(checkDenyTransit(p, patterns)).toBeNull();
  });

  it("ignores caller and target when matching", () => {
    // If caller matches "**::CacheUnsafe::*" it should NOT be flagged
    // by deny-transit (it's not an intermediate).
    const p = path([
      "src/cache.ts::CacheUnsafe::write(0)",
      "src/safe.ts::Safe::wrap(0)",
      "src/db.ts::Db::query(1)",
    ]);
    const patterns = [compilePattern("**::CacheUnsafe::*")];
    expect(checkDenyTransit(p, patterns)).toBeNull();
  });

  it("returns null on empty patterns", () => {
    const p = path([
      "src/a.ts::A(0)",
      "src/b.ts::B(0)",
      "src/c.ts::C(0)",
    ]);
    expect(checkDenyTransit(p, [])).toBeNull();
  });
});

describe("checkMustBePrecededBy / checkMustBeFollowedBy", () => {
  const edges = [
    { toId: "src/perm.ts::permission::verify(2)", line: 5, column: 4 },
    { toId: "extern:stripe::Charges::create(2)", line: 10, column: 4 },
    { toId: "src/audit.ts::audit::write(1)", line: 15, column: 4 },
  ];
  const verifyPattern = [compilePattern("**::permission::verify(*)")];
  const auditPattern = [compilePattern("**::audit::write(*)")];

  it("preceded-by passes when verify before stripe.charge", () => {
    expect(
      checkMustBePrecededBy(edges, 10, 4, verifyPattern),
    ).toBe(false);
  });

  it("preceded-by fails when verify only AFTER the target", () => {
    // Move verify to after stripe.
    const edges2 = [
      { toId: "extern:stripe::Charges::create(2)", line: 10, column: 4 },
      { toId: "src/perm.ts::permission::verify(2)", line: 20, column: 4 },
    ];
    expect(checkMustBePrecededBy(edges2, 10, 4, verifyPattern)).toBe(true);
  });

  it("preceded-by fails when no verify call exists at all", () => {
    const edges2 = [
      { toId: "extern:stripe::Charges::create(2)", line: 10, column: 4 },
    ];
    expect(checkMustBePrecededBy(edges2, 10, 4, verifyPattern)).toBe(true);
  });

  it("followed-by passes when audit after stripe.charge", () => {
    expect(
      checkMustBeFollowedBy(edges, 10, 4, auditPattern),
    ).toBe(false);
  });

  it("followed-by fails when no audit appears after the target", () => {
    const edges2 = [
      { toId: "src/audit.ts::audit::write(1)", line: 5, column: 4 },
      { toId: "extern:stripe::Charges::create(2)", line: 10, column: 4 },
    ];
    expect(checkMustBeFollowedBy(edges2, 10, 4, auditPattern)).toBe(true);
  });

  it("followed-by fails when no audit call exists at all", () => {
    const edges2 = [
      { toId: "extern:stripe::Charges::create(2)", line: 10, column: 4 },
    ];
    expect(checkMustBeFollowedBy(edges2, 10, 4, auditPattern)).toBe(true);
  });

  it("preceded-by returns false when no patterns", () => {
    expect(checkMustBePrecededBy(edges, 10, 4, [])).toBe(false);
  });

  it("followed-by returns false when no patterns", () => {
    expect(checkMustBeFollowedBy(edges, 10, 4, [])).toBe(false);
  });

  it("call on the SAME line and column as target is not 'before'", () => {
    const edges2 = [
      { toId: "src/perm.ts::permission::verify(2)", line: 10, column: 4 },
      { toId: "extern:stripe::Charges::create(2)", line: 10, column: 4 },
    ];
    // verify is at (10,4) and so is the target; preceded-by should fail
    // (not strictly before).
    expect(checkMustBePrecededBy(edges2, 10, 4, verifyPattern)).toBe(true);
  });

  it("arity-wildcard pattern matches both arities", () => {
    const e = [
      { toId: "src/x.ts::F(1)", line: 1, column: 1 },
      { toId: "src/x.ts::F(3)", line: 2, column: 1 },
    ];
    const patterns = [compilePattern("src/x.ts::F(*)")];
    expect(checkMustBePrecededBy(e, 5, 1, patterns)).toBe(false);
  });
});
