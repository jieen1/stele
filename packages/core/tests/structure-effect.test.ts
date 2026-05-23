import { describe, expect, it } from "vitest";
import type { ListNode } from "../src/index";
import { SteleError, parseFile } from "../src/index";
import {
  parseEffectAnnotationDeclaration,
  parseEffectDeclarationsDeclaration,
  parseEffectPolicyDeclaration,
  parseEffectSuppressionDeclaration,
  type EffectAnnotationDeclaration,
  type EffectDeclarationsDeclaration,
  type EffectPolicyDeclaration,
  type EffectSuppressionDeclaration,
} from "../src/validator/structure-effect.js";

const FILE_PATH = "test.stele";

function parseTopList(source: string): ListNode {
  const parsed = parseFile(source, FILE_PATH);
  const node = parsed.body[0];

  if (node === undefined || node.kind !== "list") {
    throw new Error(`Expected top-level list node, got ${node?.kind ?? "undefined"}`);
  }

  return node;
}

function parseDecls(source: string): EffectDeclarationsDeclaration {
  return parseEffectDeclarationsDeclaration(FILE_PATH, parseTopList(source));
}

function parseAnnot(source: string): EffectAnnotationDeclaration {
  return parseEffectAnnotationDeclaration(FILE_PATH, parseTopList(source));
}

function parsePolicy(source: string): EffectPolicyDeclaration {
  return parseEffectPolicyDeclaration(FILE_PATH, parseTopList(source));
}

function parseSupp(source: string): EffectSuppressionDeclaration {
  return parseEffectSuppressionDeclaration(FILE_PATH, parseTopList(source));
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

// ============================================================================
// effect-declarations
// ============================================================================

describe("parseEffectDeclarationsDeclaration", () => {
  it("parses a single effect", () => {
    const decl = parseDecls('(effect-declarations (effect "db.read"))');
    expect(decl.kind).toBe("effect-declarations");
    expect(decl.effects).toHaveLength(1);
    expect(decl.effects[0]?.name).toBe("db.read");
    expect(decl.effects[0]?.description).toBeUndefined();
    expect(decl.filePath).toBe(FILE_PATH);
  });

  it("parses multiple effects", () => {
    const decl = parseDecls(
      '(effect-declarations\n' +
        '  (effect "db.read")\n' +
        '  (effect "db.write")\n' +
        '  (effect "http.outgoing"))',
    );
    expect(decl.effects).toHaveLength(3);
    expect(decl.effects.map((e) => e.name)).toEqual(["db.read", "db.write", "http.outgoing"]);
  });

  it("parses effects with descriptions", () => {
    const decl = parseDecls(
      '(effect-declarations\n' +
        '  (effect "db.read" (description "Reading from database"))\n' +
        '  (effect "db.write" (description "Writing to database")))',
    );
    expect(decl.effects[0]?.description).toBe("Reading from database");
    expect(decl.effects[1]?.description).toBe("Writing to database");
  });

  it("accepts dot-notation names", () => {
    const decl = parseDecls(
      '(effect-declarations (effect "db.read") (effect "payment.charge") (effect "time.now"))',
    );
    expect(decl.effects.map((e) => e.name)).toEqual(["db.read", "payment.charge", "time.now"]);
  });

  it("accepts a bare lowercase identifier as effect name", () => {
    const decl = parseDecls("(effect-declarations (effect render))");
    expect(decl.effects[0]?.name).toBe("render");
  });

  it("rejects camelCase effect names (E0350)", () => {
    expectSteleError(
      () => parseDecls('(effect-declarations (effect "dbRead"))'),
      { code: "E0350", messageIncludes: 'Effect name "dbRead" violates dot-notation' },
    );
  });

  it("rejects uppercase effect names (E0350)", () => {
    expectSteleError(
      () => parseDecls('(effect-declarations (effect "DB"))'),
      { code: "E0350", messageIncludes: 'Effect name "DB" violates dot-notation' },
    );
  });

  it("rejects empty effect entry (E0353)", () => {
    expectSteleError(
      () => parseDecls("(effect-declarations (effect))"),
      { code: "E0353", messageIncludes: "Effect entry is missing" },
    );
  });

  it("rejects unknown field inside effect-declarations (E0354)", () => {
    expectSteleError(
      () => parseDecls('(effect-declarations (oops "db.read"))'),
      { code: "E0354", messageIncludes: 'unknown field "oops"' },
    );
  });

  it("rejects unknown field inside (effect ...) entry (E0354)", () => {
    expectSteleError(
      () => parseDecls('(effect-declarations (effect "db.read" (alias "x")))'),
      { code: "E0354", messageIncludes: 'unknown field "alias"' },
    );
  });

  it("rejects duplicate effect within a single block (E0352)", () => {
    expectSteleError(
      () => parseDecls('(effect-declarations (effect "db.read") (effect "db.read"))'),
      { code: "E0352", messageIncludes: 'declared more than once' },
    );
  });
});

// ============================================================================
// effect-annotation
// ============================================================================

describe("parseEffectAnnotationDeclaration", () => {
  it("parses a valid annotation with single effect", () => {
    const annot = parseAnnot(
      '(effect-annotation\n' +
        '  (target "extern:typeorm::*")\n' +
        '  (annotates "db.read"))',
    );
    expect(annot.kind).toBe("effect-annotation");
    expect(annot.target).toEqual(["extern:typeorm::*"]);
    expect(annot.annotates).toEqual(["db.read"]);
  });

  it("parses an annotation with multiple targets and effects", () => {
    const annot = parseAnnot(
      '(effect-annotation\n' +
        '  (target "extern:stripe::*" "extern:adyen::*")\n' +
        '  (annotates "payment.charge" "payment.refund" "http.outgoing"))',
    );
    expect(annot.target).toHaveLength(2);
    expect(annot.annotates).toEqual(["payment.charge", "payment.refund", "http.outgoing"]);
  });

  it("accepts a glob effect reference (payment.*)", () => {
    const annot = parseAnnot(
      '(effect-annotation (target "extern:stripe::*") (annotates "payment.*"))',
    );
    expect(annot.annotates).toEqual(["payment.*"]);
  });

  it("rejects missing target (E0355)", () => {
    expectSteleError(
      () => parseAnnot('(effect-annotation (annotates "db.read"))'),
      { code: "E0355", messageIncludes: "must declare a non-empty (target ...) field" },
    );
  });

  it("rejects missing annotates (E0356)", () => {
    expectSteleError(
      () => parseAnnot('(effect-annotation (target "extern:typeorm::*"))'),
      { code: "E0356", messageIncludes: "must declare a non-empty (annotates ...) field" },
    );
  });

  it("rejects malformed pattern (E0335)", () => {
    expectSteleError(
      () => parseAnnot('(effect-annotation (target "extern:typeorm::") (annotates "db.read"))'),
      { code: "E0335", messageIncludes: 'trailing "::" separator' },
    );
  });

  it("rejects unknown field (E0359)", () => {
    expectSteleError(
      () =>
        parseAnnot(
          '(effect-annotation (target "extern:t::*") (annotates "db.read") (oops "x"))',
        ),
      { code: "E0359", messageIncludes: 'unknown field "oops"' },
    );
  });
});

// ============================================================================
// effect-policy
// ============================================================================

describe("parseEffectPolicyDeclaration", () => {
  it("parses a policy with forbid", () => {
    const policy = parsePolicy(
      '(effect-policy NO_IO_IN_UI\n' +
        '  (target-scope "**/views/**" "**/components/**")\n' +
        '  (forbid "db.read" "db.write" "http.outgoing"))',
    );
    expect(policy.kind).toBe("effect-policy");
    expect(policy.id).toBe("NO_IO_IN_UI");
    expect(policy.targetScope).toEqual(["**/views/**", "**/components/**"]);
    expect(policy.forbid).toEqual(["db.read", "db.write", "http.outgoing"]);
    expect(policy.allowOnly).toBeUndefined();
    expect(policy.severity).toBe("error");
  });

  it("parses a policy with allow-only", () => {
    const policy = parsePolicy(
      '(effect-policy PURE_LIB\n' +
        '  (target-scope "**/lib/pure/**")\n' +
        '  (allow-only "time.now"))',
    );
    expect(policy.forbid).toBeUndefined();
    expect(policy.allowOnly).toEqual(["time.now"]);
  });

  it("accepts empty allow-only list (= nothing allowed)", () => {
    const policy = parsePolicy(
      '(effect-policy REDUCERS_PURE\n' +
        '  (target-scope "**/reducers/**")\n' +
        '  (allow-only))',
    );
    expect(policy.allowOnly).toEqual([]);
  });

  it("rejects declaring both forbid and allow-only (E0358)", () => {
    expectSteleError(
      () =>
        parsePolicy(
          '(effect-policy BAD\n' +
            '  (target-scope "**/views/**")\n' +
            '  (forbid "db.read")\n' +
            '  (allow-only "time.now"))',
        ),
      { code: "E0358", messageIncludes: "declares both (forbid ...) and (allow-only ...)" },
    );
  });

  it("rejects when neither forbid nor allow-only is declared (E0359)", () => {
    expectSteleError(
      () =>
        parsePolicy(
          '(effect-policy NO_CONSTRAINT\n' +
            '  (target-scope "**/views/**"))',
        ),
      { code: "E0359", messageIncludes: "must declare either (forbid ...) or (allow-only ...)" },
    );
  });

  it("defaults severity to error", () => {
    const policy = parsePolicy(
      '(effect-policy P (target-scope "**/x/**") (forbid "db.read"))',
    );
    expect(policy.severity).toBe("error");
  });

  it("accepts explicit severity warning", () => {
    const policy = parsePolicy(
      '(effect-policy P (target-scope "**/x/**") (forbid "db.read") (severity "warning"))',
    );
    expect(policy.severity).toBe("warning");
  });

  it("rejects invalid severity (E0336)", () => {
    expectSteleError(
      () =>
        parsePolicy(
          '(effect-policy P (target-scope "**/x/**") (forbid "db.read") (severity "info"))',
        ),
      { code: "E0336", messageIncludes: 'severity must be "error" or "warning"' },
    );
  });

  it("rejects a vague fix-hint (E0339)", () => {
    expectSteleError(
      () =>
        parsePolicy(
          '(effect-policy P (target-scope "**/x/**") (forbid "db.read") ' +
            '(fix-hint "Move things around."))',
        ),
      { code: "E0339", messageIncludes: "fix-hint is too vague" },
    );
  });

  it("accepts a backtick-quoted fix-hint", () => {
    const policy = parsePolicy(
      '(effect-policy P (target-scope "**/x/**") (forbid "db.read") ' +
        '(fix-hint "Move IO to `services/`. UI receives props."))',
    );
    expect(policy.fixHint).toBe("Move IO to `services/`. UI receives props.");
  });

  it("accepts a file:line fix-hint", () => {
    const policy = parsePolicy(
      '(effect-policy P (target-scope "**/x/**") (forbid "db.read") ' +
        '(fix-hint "see src/components/UserCard.tsx:23 for the offending caller"))',
    );
    expect(policy.fixHint).toContain("src/components/UserCard.tsx:23");
  });

  it("rejects a malformed target-scope pattern (E0335)", () => {
    expectSteleError(
      () =>
        parsePolicy(
          '(effect-policy P (target-scope "**/views::") (forbid "db.read"))',
        ),
      { code: "E0335", messageIncludes: 'trailing "::"' },
    );
  });

  it("rejects unknown fields (E0359)", () => {
    expectSteleError(
      () =>
        parsePolicy(
          '(effect-policy P (target-scope "**/x/**") (forbid "db.read") (oops 1))',
        ),
      { code: "E0359", messageIncludes: 'unknown field "oops"' },
    );
  });
});

// ============================================================================
// effect-suppression
// ============================================================================

describe("parseEffectSuppressionDeclaration", () => {
  it("parses a valid suppression with a single suppressed effect", () => {
    const supp = parseSupp(
      '(effect-suppression\n' +
        '  (target "src/cache/cached-get.ts::cachedGet(1)")\n' +
        '  (suppresses "db.read")\n' +
        '  (reason "Caching wrapper around getUser. Intentional."))',
    );
    expect(supp.kind).toBe("effect-suppression");
    expect(supp.target).toBe("src/cache/cached-get.ts::cachedGet(1)");
    expect(supp.suppresses).toEqual(["db.read"]);
    expect(supp.reason).toContain("Caching wrapper");
    expect(supp.severity).toBe("warning");
  });

  it("parses a suppression with multiple effects", () => {
    const supp = parseSupp(
      '(effect-suppression\n' +
        '  (target "src/x.ts::wrap(1)")\n' +
        '  (suppresses "db.read" "db.write")\n' +
        '  (reason "Wrapper intentionally proxies all DB calls."))',
    );
    expect(supp.suppresses).toEqual(["db.read", "db.write"]);
  });

  it("defaults severity to warning", () => {
    const supp = parseSupp(
      '(effect-suppression (target "x::y(1)") (suppresses "db.read") (reason "ok"))',
    );
    expect(supp.severity).toBe("warning");
  });

  it("accepts explicit severity error", () => {
    const supp = parseSupp(
      '(effect-suppression (target "x::y(1)") (suppresses "db.read") (reason "ok") (severity "error"))',
    );
    expect(supp.severity).toBe("error");
  });

  it("rejects missing reason (E0357)", () => {
    expectSteleError(
      () =>
        parseSupp(
          '(effect-suppression (target "x::y(1)") (suppresses "db.read"))',
        ),
      { code: "E0357", messageIncludes: "missing the required (reason" },
    );
  });

  it("rejects empty reason (E0357)", () => {
    expectSteleError(
      () =>
        parseSupp(
          '(effect-suppression (target "x::y(1)") (suppresses "db.read") (reason ""))',
        ),
      { code: "E0357", messageIncludes: "reason must be a non-empty string" },
    );
  });

  it("rejects missing target (E0359)", () => {
    expectSteleError(
      () =>
        parseSupp(
          '(effect-suppression (suppresses "db.read") (reason "ok"))',
        ),
      { code: "E0359", messageIncludes: "must declare a (target" },
    );
  });

  it("rejects missing suppresses (E0359)", () => {
    expectSteleError(
      () =>
        parseSupp(
          '(effect-suppression (target "x::y(1)") (reason "ok"))',
        ),
      { code: "E0359", messageIncludes: "non-empty (suppresses ...)" },
    );
  });

  it("rejects unknown field (E0359)", () => {
    expectSteleError(
      () =>
        parseSupp(
          '(effect-suppression (target "x::y(1)") (suppresses "db.read") (reason "ok") (oops 1))',
        ),
      { code: "E0359", messageIncludes: 'unknown field "oops"' },
    );
  });

  it("rejects invalid severity (E0336)", () => {
    expectSteleError(
      () =>
        parseSupp(
          '(effect-suppression (target "x::y(1)") (suppresses "db.read") (reason "ok") (severity "info"))',
        ),
      { code: "E0336", messageIncludes: 'severity must be "warning" or "error"' },
    );
  });
});

// ============================================================================
// Cross-form integration (parser-only behavior)
// ============================================================================

describe("effect forms — cross-form integration (parse only)", () => {
  it("parses an effect-policy that references effects not declared locally (deferred to evaluator)", () => {
    // The parser does NOT cross-check that effect names in forbid/allow-only
    // are declared elsewhere; that resolution belongs to the evaluator stage.
    const policy = parsePolicy(
      '(effect-policy LATER\n' +
        '  (target-scope "**/views/**")\n' +
        '  (forbid "not.yet.declared" "payment.charge"))',
    );
    expect(policy.forbid).toEqual(["not.yet.declared", "payment.charge"]);
  });

  it("parses an effect-annotation referencing an effect declared elsewhere — no parse error", () => {
    const annot = parseAnnot(
      '(effect-annotation (target "x::y(*)") (annotates "likely.declared.elsewhere"))',
    );
    expect(annot.annotates).toEqual(["likely.declared.elsewhere"]);
  });

  it("parses all four effect forms together in a single file body", () => {
    const source = [
      '(effect-declarations (effect "db.read") (effect "http.outgoing"))',
      '(effect-annotation (target "extern:typeorm::*") (annotates "db.read"))',
      '(effect-policy NO_IO_IN_UI (target-scope "**/views/**") (forbid "db.read" "http.outgoing"))',
      '(effect-suppression (target "src/cache/get.ts::get(1)")',
      '  (suppresses "db.read") (reason "Intentional caching wrapper."))',
    ].join("\n");

    const parsed = parseFile(source, FILE_PATH);
    expect(parsed.body).toHaveLength(4);
    const heads = parsed.body.map((node) => (node.kind === "list" ? node.head : "atom"));
    expect(heads).toEqual([
      "effect-declarations",
      "effect-annotation",
      "effect-policy",
      "effect-suppression",
    ]);
  });
});
