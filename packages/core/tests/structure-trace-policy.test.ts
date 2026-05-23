import { describe, expect, it } from "vitest";
import type { ListNode } from "../src/index";
import { SteleError, parseFile, isFixHintActionable } from "../src/index";
import {
  parseTracePolicyDeclaration,
  type TracePolicyDeclaration,
} from "../src/validator/structure-trace-policy.js";

const FILE_PATH = "test.stele";

function parseTopList(source: string): ListNode {
  const parsed = parseFile(source, FILE_PATH);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error(`Expected top-level list node, got ${node?.kind ?? "undefined"}`);
  }

  return node;
}

function parsePolicy(source: string): TracePolicyDeclaration {
  return parseTracePolicyDeclaration(FILE_PATH, parseTopList(source));
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

describe("parseTracePolicyDeclaration — happy path", () => {
  it("parses a minimal trace-policy with target + one must-transit", () => {
    const policy = parsePolicy(
      '(trace-policy DB_VIA_REPOSITORY\n' +
        '  (target "**::OrderService::*")\n' +
        '  (must-transit "**::Repository::*"))',
    );
    expect(policy.kind).toBe("trace-policy");
    expect(policy.id).toBe("DB_VIA_REPOSITORY");
    expect(policy.target).toEqual(["**::OrderService::*"]);
    expect(policy.mustTransit).toEqual(["**::Repository::*"]);
    expect(policy.severity).toBe("error");
    expect(policy.exempt).toEqual([]);
    expect(policy.scope).toEqual([]);
    expect(policy.filePath).toBe(FILE_PATH);
  });

  it("parses a full trace-policy with every field populated", () => {
    const policy = parsePolicy(
      '(trace-policy FULL_POLICY\n' +
        '  (description "Every clause exercised.")\n' +
        '  (severity "warning")\n' +
        '  (target "**::OrderService::*" "**::PaymentService::*")\n' +
        '  (must-transit "**::Repository::*")\n' +
        '  (must-be-preceded-by "**::Authz::check(*)")\n' +
        '  (must-be-followed-by "**::AuditLog::write(*)")\n' +
        '  (deny-direct "extern:fs::*")\n' +
        '  (deny-transit "extern:net::*")\n' +
        '  (scope "src/**/*.ts")\n' +
        '  (exempt "src/admin/**::*" (reason "admin tooling bypasses repo"))\n' +
        '  (fix-hint "wrap in `Repository.findById` — see src/repo.ts:42"))',
    );
    expect(policy.id).toBe("FULL_POLICY");
    expect(policy.description).toBe("Every clause exercised.");
    expect(policy.severity).toBe("warning");
    expect(policy.target).toEqual(["**::OrderService::*", "**::PaymentService::*"]);
    expect(policy.mustTransit).toEqual(["**::Repository::*"]);
    expect(policy.mustBePrecededBy).toEqual(["**::Authz::check(*)"]);
    expect(policy.mustBeFollowedBy).toEqual(["**::AuditLog::write(*)"]);
    expect(policy.denyDirect).toEqual(["extern:fs::*"]);
    expect(policy.denyTransit).toEqual(["extern:net::*"]);
    expect(policy.scope).toEqual(["src/**/*.ts"]);
    expect(policy.exempt).toHaveLength(1);
    expect(policy.exempt[0]?.pattern).toBe("src/admin/**::*");
    expect(policy.exempt[0]?.reason).toBe("admin tooling bypasses repo");
    expect(policy.fixHint).toBe("wrap in `Repository.findById` — see src/repo.ts:42");
  });

  it("accepts multiple targets", () => {
    const policy = parsePolicy(
      '(trace-policy MULTI\n' +
        '  (target "a::*" "b::*" "c::*")\n' +
        '  (deny-direct "extern:fs::*"))',
    );
    expect(policy.target).toEqual(["a::*", "b::*", "c::*"]);
  });

  it("accepts must-be-preceded-by as the only constraint", () => {
    const policy = parsePolicy(
      '(trace-policy OK\n' +
        '  (target "**::Handler::*")\n' +
        '  (must-be-preceded-by "**::Authz::*"))',
    );
    expect(policy.mustBePrecededBy).toEqual(["**::Authz::*"]);
  });

  it("accepts must-be-followed-by as the only constraint", () => {
    const policy = parsePolicy(
      '(trace-policy OK\n' +
        '  (target "**::Mutator::*")\n' +
        '  (must-be-followed-by "**::AuditLog::*"))',
    );
    expect(policy.mustBeFollowedBy).toEqual(["**::AuditLog::*"]);
  });

  it("accepts deny-direct as the only constraint", () => {
    const policy = parsePolicy(
      '(trace-policy OK\n' +
        '  (target "**::Service::*")\n' +
        '  (deny-direct "extern:fs::*"))',
    );
    expect(policy.denyDirect).toEqual(["extern:fs::*"]);
  });

  it("accepts deny-transit as the only constraint", () => {
    const policy = parsePolicy(
      '(trace-policy OK\n' +
        '  (target "**::Service::*")\n' +
        '  (deny-transit "extern:net::*"))',
    );
    expect(policy.denyTransit).toEqual(["extern:net::*"]);
  });

  it("accepts multiple exempt entries", () => {
    const policy = parsePolicy(
      '(trace-policy MULTI_EXEMPT\n' +
        '  (target "**::Svc::*")\n' +
        '  (deny-direct "extern:fs::*")\n' +
        '  (exempt "src/migrations/**::*" (reason "schema migrations need fs"))\n' +
        '  (exempt "src/seed/**::*" (reason "seed scripts allowed at boot")))',
    );
    expect(policy.exempt).toHaveLength(2);
    expect(policy.exempt[0]?.pattern).toBe("src/migrations/**::*");
    expect(policy.exempt[1]?.reason).toBe("seed scripts allowed at boot");
  });

  it("severity defaults to error when omitted", () => {
    const policy = parsePolicy(
      '(trace-policy DEFAULT_SEV\n' +
        '  (target "**::Svc::*")\n' +
        '  (deny-direct "extern:fs::*"))',
    );
    expect(policy.severity).toBe("error");
  });

  it("severity warning is preserved", () => {
    const policy = parsePolicy(
      '(trace-policy WARN_SEV\n' +
        '  (severity "warning")\n' +
        '  (target "**::Svc::*")\n' +
        '  (deny-direct "extern:fs::*"))',
    );
    expect(policy.severity).toBe("warning");
  });

  it("returns frozen-like readonly arrays for unused constraints", () => {
    const policy = parsePolicy(
      '(trace-policy EMPTYISH\n' +
        '  (target "**::Svc::*")\n' +
        '  (must-transit "**::Repo::*"))',
    );
    expect(policy.denyDirect).toEqual([]);
    expect(policy.denyTransit).toEqual([]);
    expect(policy.mustBePrecededBy).toEqual([]);
    expect(policy.mustBeFollowedBy).toEqual([]);
    expect(policy.scope).toEqual([]);
  });
});

describe("parseTracePolicyDeclaration — error paths", () => {
  it("E0330: missing id throws", () => {
    const node = parseTopList('(trace-policy (target "**::S::*"))');
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0330",
      messageIncludes: "Trace-policy declarations must start with",
    });
  });

  it("E0332: missing target throws", () => {
    const node = parseTopList('(trace-policy NO_TARGET (must-transit "**::Repo::*"))');
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0332",
      messageIncludes: "must declare a non-empty (target ...)",
    });
  });

  it("E0332: empty target list throws", () => {
    const node = parseTopList('(trace-policy NO_TARGET (target) (must-transit "**::Repo::*"))');
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0332",
      messageIncludes: "must contain at least one pattern",
    });
  });

  it("E0333: target without any must-*/deny-* throws", () => {
    const node = parseTopList('(trace-policy NO_CONSTRAINT (target "**::S::*"))');
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0333",
      messageIncludes: "must declare at least one must-* or deny-* constraint",
    });
  });

  it("E0334: exempt without reason throws", () => {
    const node = parseTopList(
      '(trace-policy NO_REASON\n' +
        '  (target "**::S::*")\n' +
        '  (deny-direct "extern:fs::*")\n' +
        '  (exempt "src/admin/**::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0334",
      messageIncludes: "exempt",
    });
  });

  it("E0335: empty pattern throws", () => {
    const node = parseTopList(
      '(trace-policy BAD_PAT (target "") (must-transit "**::R::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0335",
      messageIncludes: "non-empty string",
    });
  });

  it("E0335: whitespace-only pattern throws", () => {
    const node = parseTopList(
      '(trace-policy BAD_PAT (target "   ") (must-transit "**::R::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0335",
      messageIncludes: "non-empty string",
    });
  });

  it("E0335: malformed arity throws", () => {
    const node = parseTopList(
      '(trace-policy BAD_PAT (target "src/x.ts::C::m(notanumber)") (must-transit "**::R::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0335",
      messageIncludes: "malformed arity",
    });
  });

  it("E0335: trailing `::` throws", () => {
    const node = parseTopList(
      '(trace-policy BAD_PAT (target "src/x.ts::C::") (must-transit "**::R::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0335",
      messageIncludes: 'trailing "::"',
    });
  });

  it("E0336: severity other than error/warning throws", () => {
    const node = parseTopList(
      '(trace-policy BAD_SEV\n' +
        '  (severity "info")\n' +
        '  (target "**::S::*")\n' +
        '  (deny-direct "extern:fs::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0336",
      messageIncludes: 'severity must be "error" or "warning"',
    });
  });

  it("E0337: two (target ...) clauses throws", () => {
    const node = parseTopList(
      '(trace-policy DUPE\n' +
        '  (target "a::*")\n' +
        '  (target "b::*")\n' +
        '  (must-transit "**::R::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0337",
      messageIncludes: "target",
    });
  });

  it("E0337: two (severity ...) clauses throws", () => {
    const node = parseTopList(
      '(trace-policy DUPE_SEV\n' +
        '  (severity "error")\n' +
        '  (severity "warning")\n' +
        '  (target "**::S::*")\n' +
        '  (deny-direct "extern:fs::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0337",
      messageIncludes: "severity",
    });
  });

  it("E0338: unknown field throws", () => {
    const node = parseTopList(
      '(trace-policy UNK\n' +
        '  (target "**::S::*")\n' +
        '  (must-transit "**::R::*")\n' +
        '  (mystery "x"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0338",
      messageIncludes: 'unknown field "mystery"',
    });
  });

  it("E0339: vague fix-hint (pure prose) throws", () => {
    const node = parseTopList(
      '(trace-policy VAGUE_HINT\n' +
        '  (target "**::S::*")\n' +
        '  (deny-direct "extern:fs::*")\n' +
        '  (fix-hint "must verify permission"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0339",
      messageIncludes: "vague",
    });
  });

  it("E0339: fix-hint accepts backtick-quoted code", () => {
    const policy = parsePolicy(
      '(trace-policy HINT_OK\n' +
        '  (target "**::S::*")\n' +
        '  (deny-direct "extern:fs::*")\n' +
        '  (fix-hint "use `Repository.find` instead"))',
    );
    expect(policy.fixHint).toBe("use `Repository.find` instead");
  });

  it("E0339: fix-hint accepts file:line reference", () => {
    const policy = parsePolicy(
      '(trace-policy HINT_OK\n' +
        '  (target "**::S::*")\n' +
        '  (deny-direct "extern:fs::*")\n' +
        '  (fix-hint "see src/db/repo.ts:42"))',
    );
    expect(policy.fixHint).toBe("see src/db/repo.ts:42");
  });

  it("rejects a non-list field entry", () => {
    const node = parseTopList(
      '(trace-policy MIX "stray" (target "**::S::*") (deny-direct "extern:fs::*"))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0338",
      messageIncludes: "unsupported entry",
    });
  });
});

describe("parseTracePolicyDeclaration — pattern integration", () => {
  it("accepts extern shorthand pattern", () => {
    const policy = parsePolicy(
      '(trace-policy EXT\n' +
        '  (target "**::Svc::*")\n' +
        '  (deny-direct "extern:stripe::*"))',
    );
    expect(policy.denyDirect).toEqual(["extern:stripe::*"]);
  });

  it("accepts pattern with explicit arity", () => {
    const policy = parsePolicy(
      '(trace-policy ARITY\n' +
        '  (target "**::Order::pay(2)")\n' +
        '  (must-transit "**::Repository::*"))',
    );
    expect(policy.target).toEqual(["**::Order::pay(2)"]);
  });

  it("accepts pattern with disambiguator", () => {
    const policy = parsePolicy(
      '(trace-policy DIS\n' +
        '  (target "**::Order::pay(2)#abc12345")\n' +
        '  (must-transit "**::Repository::*"))',
    );
    expect(policy.target).toEqual(["**::Order::pay(2)#abc12345"]);
  });

  it("accepts brace-expansion pattern", () => {
    const policy = parsePolicy(
      '(trace-policy BRACE\n' +
        '  (target "**/*.{ts,py}::*")\n' +
        '  (must-transit "**::Repo::*"))',
    );
    expect(policy.target).toEqual(["**/*.{ts,py}::*"]);
  });

  it("rejects empty pattern in must-transit too", () => {
    const node = parseTopList(
      '(trace-policy BAD_PAT (target "**::S::*") (must-transit ""))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0335",
      messageIncludes: "non-empty string",
    });
  });

  it("rejects empty pattern in exempt", () => {
    const node = parseTopList(
      '(trace-policy BAD_PAT\n' +
        '  (target "**::S::*")\n' +
        '  (deny-direct "extern:fs::*")\n' +
        '  (exempt "" (reason "x")))',
    );
    expectSteleError(() => parseTracePolicyDeclaration(FILE_PATH, node), {
      code: "E0335",
      messageIncludes: "non-empty string",
    });
  });
});

describe("isFixHintActionable", () => {
  it("returns true for backtick-quoted code", () => {
    expect(isFixHintActionable("Use `parseId` here.")).toBe(true);
  });

  it("returns true for file:line reference", () => {
    expect(isFixHintActionable("See src/x.ts:42 for the helper.")).toBe(true);
  });

  it("returns false for pure prose", () => {
    expect(isFixHintActionable("Make it correct.")).toBe(false);
  });

  it("returns false for empty / whitespace", () => {
    expect(isFixHintActionable("")).toBe(false);
    expect(isFixHintActionable("   ")).toBe(false);
  });

  it("returns false for a bare colon-number that is not a path", () => {
    expect(isFixHintActionable("at 42")).toBe(false);
  });
});

describe("integration with the top-level parser", () => {
  it("parses trace-policy alongside other top-level forms", () => {
    const source =
      '(trace-policy A (target "**::S::*") (deny-direct "extern:fs::*"))\n' +
      '(trace-policy B (target "**::S2::*") (must-transit "**::R::*"))\n';
    const parsed = parseFile(source, FILE_PATH);
    expect(parsed.body).toHaveLength(2);
    expect((parsed.body[0] as ListNode).head).toBe("trace-policy");
    expect((parsed.body[1] as ListNode).head).toBe("trace-policy");
  });
});
