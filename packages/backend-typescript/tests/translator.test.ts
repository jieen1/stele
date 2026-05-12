import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContract, parseFile, SteleError, type AstNode, type Contract } from "@stele/core";
import * as backendTypeScript from "../src/index.js";
import {
  generateVitestSource,
  sanitizeTsIdentifier,
  translateExpression,
} from "../src/translator.js";
import { getTypeScriptRuntimeSource } from "../src/runtime.js";

const tempDirs: string[] = [];

describe("@stele/backend-typescript translator", () => {
  afterEach(async () => {
    await Promise.allSettled(
      tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  describe("public exports", () => {
    it("re-exports translator + runtime helpers + default backend from the package index", () => {
      expect(typeof backendTypeScript.generateVitestSource).toBe("function");
      expect(typeof backendTypeScript.translateExpression).toBe("function");
      expect(typeof backendTypeScript.sanitizeTsIdentifier).toBe("function");
      expect(typeof backendTypeScript.getTypeScriptRuntimeSource).toBe("function");
      expect(backendTypeScript.TYPESCRIPT_RUNTIME_PATH).toBe("tests/contract/_stele_runtime.ts");

      const defaultBackend = backendTypeScript.default;
      expect(defaultBackend.name).toBe("typescript");
      expect(defaultBackend.framework).toBe("vitest");
      expect(defaultBackend.fileExtension).toBe(".ts");
      expect(typeof defaultBackend.generate).toBe("function");
      expect(backendTypeScript.backend).toBe(defaultBackend);
    });
  });

  describe("path translator", () => {
    it("emits steleGetPath against the root context", () => {
      expect(translateExpression(parseExpression("(path account cash)"))).toBe(
        'runtime.steleGetPath(ctx, ["account", "cash"])',
      );
    });

    it("emits a single-segment path against the root context", () => {
      expect(translateExpression(parseExpression("(path account)"))).toBe(
        'runtime.steleGetPath(ctx, ["account"])',
      );
    });

    it("rejects empty path expressions with E0603", () => {
      expect(() => translateExpression(parseExpression("(path)"))).toThrow(SteleError);
      try {
        translateExpression(parseExpression("(path)"));
      } catch (error) {
        expect(error).toBeInstanceOf(SteleError);
        expect((error as SteleError).code).toBe("E0603");
      }
    });

    it("rejects non-symbol path segments with E0603", () => {
      expect(() => translateExpression(parseExpression("(path account 5)"))).toThrow(SteleError);
    });
  });

  describe("comparison operators", () => {
    it("translates eq via runtime.steleEq", () => {
      expect(translateExpression(parseExpression("(eq (path foo) 5)"))).toMatch(
        /runtime\.steleEq\(runtime\.steleGetPath\(ctx, \["foo"\]\), 5\)/,
      );
    });

    it("translates neq via runtime.steleNeq", () => {
      expect(translateExpression(parseExpression("(neq 1 2)"))).toBe(
        "runtime.steleNeq(1, 2)",
      );
    });

    it("translates gt via runtime.steleGt", () => {
      expect(translateExpression(parseExpression("(gt (path account balance) 0)"))).toBe(
        'runtime.steleGt(runtime.steleGetPath(ctx, ["account", "balance"]), 0)',
      );
    });

    it("translates gte via runtime.steleGte", () => {
      expect(translateExpression(parseExpression("(gte 5 5)"))).toBe(
        "runtime.steleGte(5, 5)",
      );
    });

    it("translates lt via runtime.steleLt", () => {
      expect(translateExpression(parseExpression("(lt 1 2)"))).toBe(
        "runtime.steleLt(1, 2)",
      );
    });

    it("translates lte via runtime.steleLte", () => {
      expect(translateExpression(parseExpression("(lte 1 1)"))).toBe(
        "runtime.steleLte(1, 1)",
      );
    });

    it("rejects non-binary comparisons with E0603", () => {
      expect(() => translateExpression(parseExpression("(eq 1 2 3)"))).toThrow(SteleError);
    });
  });

  describe("logic operators", () => {
    it("emits and as native &&", () => {
      const out = translateExpression(parseExpression("(and (gt 1 0) (lt 1 5))"));
      expect(out).toContain("&&");
      expect(out).toContain("runtime.steleGt(1, 0)");
      expect(out).toContain("runtime.steleLt(1, 5)");
    });

    it("emits or as native ||", () => {
      const out = translateExpression(parseExpression("(or (eq 1 2) (eq 3 3))"));
      expect(out).toContain("||");
    });

    it("emits not as native !", () => {
      expect(translateExpression(parseExpression("(not (eq 1 2))"))).toMatch(
        /^!.*runtime\.steleNeq\(1, 2\)|^!.*runtime\.steleEq\(1, 2\)/,
      );
    });

    it("rejects empty (and) with E0603", () => {
      expect(() => translateExpression(parseExpression("(and)"))).toThrow(SteleError);
    });

    it("rejects (not) with multiple operands", () => {
      expect(() => translateExpression(parseExpression("(not (eq 1 1) (eq 2 2))"))).toThrow(SteleError);
    });
  });

  describe("atom translation", () => {
    it("translates booleans / null / numbers / strings to native TS literals", () => {
      expect(translateExpression(parseExpression("true"))).toBe("true");
      expect(translateExpression(parseExpression("false"))).toBe("false");
      expect(translateExpression(parseExpression("null"))).toBe("null");
      expect(translateExpression(parseExpression("none"))).toBe("null");
      expect(translateExpression(parseExpression("42"))).toBe("42");
      expect(translateExpression(parseExpression('"hello"'))).toBe('"hello"');
      expect(translateExpression(parseExpression(":foo"))).toBe('":foo"');
    });

    it("rejects unknown bare identifiers with E0602", () => {
      expect(() => translateExpression(parseExpression("foo"))).toThrow(SteleError);
      try {
        translateExpression(parseExpression("foo"));
      } catch (error) {
        expect((error as SteleError).code).toBe("E0602");
      }
    });
  });

  describe("unsupported operators", () => {
    it("rejects truly unknown operators with E0601", () => {
      // Phase C now supports forall/exists/where/none/modified/within/before/
      // after/state-before/state-after, plus scenarios/checkers/when at the
      // invariant level. The remaining unsupported expression heads are
      // genuinely out-of-registry: a small sample from EP04+ slated for later
      // phases.
      const UNSUPPORTED = ["totally-unknown-op", "subset-of", "intersect-with"];
      for (const operator of UNSUPPORTED) {
        const expr = `(${operator} 1 2)`;
        expect(() => translateExpression(parseExpression(expr))).toThrowError(SteleError);
        try {
          translateExpression(parseExpression(expr));
        } catch (error) {
          expect((error as SteleError).code).toBe("E0601");
          expect((error as SteleError).message).toContain(operator);
        }
      }
    });
  });

  describe("arithmetic operators (Phase B)", () => {
    it("translates add via runtime.steleAdd (variadic)", () => {
      expect(translateExpression(parseExpression("(add 1 2 3)"))).toBe("runtime.steleAdd(1, 2, 3)");
    });

    it("translates sub via runtime.steleSub", () => {
      expect(translateExpression(parseExpression("(sub 10 4)"))).toBe("runtime.steleSub(10, 4)");
    });

    it("translates mul via runtime.steleMul (variadic)", () => {
      expect(translateExpression(parseExpression("(mul 2 3 4)"))).toBe("runtime.steleMul(2, 3, 4)");
    });

    it("translates div via runtime.steleDiv", () => {
      expect(translateExpression(parseExpression("(div 10 2)"))).toBe("runtime.steleDiv(10, 2)");
    });

    it("translates neg via runtime.steleNeg", () => {
      expect(translateExpression(parseExpression("(neg 5)"))).toBe("runtime.steleNeg(5)");
    });

    it("translates abs via runtime.steleAbs", () => {
      expect(translateExpression(parseExpression("(abs -3)"))).toBe("runtime.steleAbs(-3)");
    });

    it("nests arithmetic helpers cleanly without infix precedence concerns", () => {
      const out = translateExpression(parseExpression("(mul (add 1 2) 3)"));
      expect(out).toBe("runtime.steleMul(runtime.steleAdd(1, 2), 3)");
    });

    it("translates path-based arithmetic so unknown values stay typed", () => {
      const out = translateExpression(parseExpression("(add (path account fee) 1)"));
      expect(out).toBe('runtime.steleAdd(runtime.steleGetPath(ctx, ["account", "fee"]), 1)');
    });

    it("rejects (add) with fewer than two operands", () => {
      expect(() => translateExpression(parseExpression("(add 1)"))).toThrowError(SteleError);
      try {
        translateExpression(parseExpression("(add 1)"));
      } catch (error) {
        expect((error as SteleError).code).toBe("E0603");
      }
    });

    it("rejects (sub 1 2 3) (binary only)", () => {
      expect(() => translateExpression(parseExpression("(sub 1 2 3)"))).toThrowError(SteleError);
    });

    it("rejects (neg 1 2)", () => {
      expect(() => translateExpression(parseExpression("(neg 1 2)"))).toThrowError(SteleError);
    });

    it("rejects (abs)", () => {
      expect(() => translateExpression(parseExpression("(abs)"))).toThrowError(SteleError);
    });
  });

  describe("aggregate operators (Phase B)", () => {
    it("translates sum via runtime.steleSum", () => {
      expect(translateExpression(parseExpression("(sum (path items) (path price))"))).toMatch(
        /runtime\.steleSum\(.+, \["price"\]\)/,
      );
    });

    it("translates sum without projection (single argument)", () => {
      expect(translateExpression(parseExpression("(sum (path items))"))).toBe(
        'runtime.steleSum(runtime.steleGetPath(ctx, ["items"]))',
      );
    });

    it("translates count via runtime.steleCount", () => {
      expect(translateExpression(parseExpression("(count (path items))"))).toBe(
        'runtime.steleCount(runtime.steleGetPath(ctx, ["items"]))',
      );
    });

    it("translates avg via runtime.steleAvg with projection", () => {
      expect(translateExpression(parseExpression("(avg (path items) (path price))"))).toBe(
        'runtime.steleAvg(runtime.steleGetPath(ctx, ["items"]), ["price"])',
      );
    });

    it("translates min via runtime.steleMin", () => {
      expect(translateExpression(parseExpression("(min (path items) (path price))"))).toBe(
        'runtime.steleMin(runtime.steleGetPath(ctx, ["items"]), ["price"])',
      );
    });

    it("translates max via runtime.steleMax", () => {
      expect(translateExpression(parseExpression("(max (path items) (path price))"))).toBe(
        'runtime.steleMax(runtime.steleGetPath(ctx, ["items"]), ["price"])',
      );
    });

    it("translates distinct via runtime.steleDistinct", () => {
      expect(translateExpression(parseExpression("(distinct (path items))"))).toBe(
        'runtime.steleDistinct(runtime.steleGetPath(ctx, ["items"]))',
      );
    });

    it("translates unique via runtime.steleUnique with projection", () => {
      expect(translateExpression(parseExpression("(unique (path items) (path id))"))).toBe(
        'runtime.steleUnique(runtime.steleGetPath(ctx, ["items"]), ["id"])',
      );
    });

    it("translates has-length via runtime.steleHasLength", () => {
      expect(translateExpression(parseExpression("(has-length (path items) 3)"))).toBe(
        'runtime.steleHasLength(runtime.steleGetPath(ctx, ["items"]), 3)',
      );
    });

    it("translates is-empty via runtime.steleIsEmpty", () => {
      expect(translateExpression(parseExpression("(is-empty (path items))"))).toBe(
        'runtime.steleIsEmpty(runtime.steleGetPath(ctx, ["items"]))',
      );
    });

    it("translates exists-in via runtime.steleExistsIn", () => {
      expect(
        translateExpression(parseExpression('(exists-in "alice" (path users))')),
      ).toBe('runtime.steleExistsIn("alice", runtime.steleGetPath(ctx, ["users"]))');
    });

    it("rejects sum with non-path projection", () => {
      expect(() => translateExpression(parseExpression("(sum (path items) 5)"))).toThrowError(SteleError);
    });

    it("rejects (count) with no operand", () => {
      expect(() => translateExpression(parseExpression("(count)"))).toThrowError(SteleError);
    });

    it("rejects (has-length items)", () => {
      expect(() => translateExpression(parseExpression("(has-length (path items))"))).toThrowError(SteleError);
    });
  });

  describe("string operators (Phase B)", () => {
    it("translates contains via runtime.steleContains", () => {
      expect(translateExpression(parseExpression('(contains "hello world" "world")'))).toBe(
        'runtime.steleContains("hello world", "world")',
      );
    });

    it("translates starts-with via runtime.steleStartsWith", () => {
      expect(translateExpression(parseExpression('(starts-with (path name) "Mr.")'))).toBe(
        'runtime.steleStartsWith(runtime.steleGetPath(ctx, ["name"]), "Mr.")',
      );
    });

    it("translates ends-with via runtime.steleEndsWith", () => {
      expect(translateExpression(parseExpression('(ends-with (path filename) ".csv")'))).toBe(
        'runtime.steleEndsWith(runtime.steleGetPath(ctx, ["filename"]), ".csv")',
      );
    });

    it("translates matches via runtime.steleMatches", () => {
      expect(translateExpression(parseExpression('(matches (path id) "^[A-Z]+")'))).toBe(
        'runtime.steleMatches(runtime.steleGetPath(ctx, ["id"]), "^[A-Z]+")',
      );
    });

    it("rejects single-operand string ops", () => {
      expect(() => translateExpression(parseExpression('(contains "hi")'))).toThrowError(SteleError);
      expect(() => translateExpression(parseExpression('(starts-with "hi")'))).toThrowError(SteleError);
      expect(() => translateExpression(parseExpression('(ends-with "hi")'))).toThrowError(SteleError);
      expect(() => translateExpression(parseExpression('(matches "hi")'))).toThrowError(SteleError);
    });
  });

  describe("control-flow operators (Phase B)", () => {
    it("translates when as a lazy implication", () => {
      const out = translateExpression(parseExpression("(when (gt (path x) 0) (lt (path x) 10))"));
      expect(out).toBe(
        '(!runtime.steleGt(runtime.steleGetPath(ctx, ["x"]), 0) || runtime.steleLt(runtime.steleGetPath(ctx, ["x"]), 10))',
      );
    });

    it("translates if as a native ternary", () => {
      expect(translateExpression(parseExpression("(if (gt (path x) 0) 1 -1)"))).toBe(
        '(runtime.steleGt(runtime.steleGetPath(ctx, ["x"]), 0) ? 1 : -1)',
      );
    });

    it("translates implies as (!a || b)", () => {
      expect(translateExpression(parseExpression("(implies (eq 1 1) (eq 2 2))"))).toBe(
        "(!runtime.steleEq(1, 1) || runtime.steleEq(2, 2))",
      );
    });

    it("translates iff as a triple-equal comparison", () => {
      expect(translateExpression(parseExpression("(iff (eq 1 1) (eq 2 2))"))).toBe(
        "(runtime.steleEq(1, 1) === runtime.steleEq(2, 2))",
      );
    });

    it("translates not-null via runtime.steleNotNull", () => {
      expect(translateExpression(parseExpression("(not-null (path account email))"))).toBe(
        'runtime.steleNotNull(runtime.steleGetPath(ctx, ["account", "email"]))',
      );
    });

    it("translates between via runtime.steleBetween", () => {
      expect(translateExpression(parseExpression("(between (path age) 18 65)"))).toBe(
        'runtime.steleBetween(runtime.steleGetPath(ctx, ["age"]), 18, 65)',
      );
    });

    it("translates approx-eq via runtime.steleApproxEq", () => {
      expect(translateExpression(parseExpression("(approx-eq (path price) 100.0 0.001)"))).toBe(
        'runtime.steleApproxEq(runtime.steleGetPath(ctx, ["price"]), 100.0, 0.001)',
      );
    });

    it("rejects (if cond)", () => {
      expect(() => translateExpression(parseExpression("(if (eq 1 1))"))).toThrowError(SteleError);
    });

    it("rejects (between v lo)", () => {
      expect(() => translateExpression(parseExpression("(between 1 0)"))).toThrowError(SteleError);
    });
  });

  describe("sanitizeTsIdentifier", () => {
    it("replaces hyphens, collapses underscores, and prefixes leading digits", () => {
      expect(sanitizeTsIdentifier("ACCT-001")).toBe("ACCT_001");
      expect(sanitizeTsIdentifier("a..b")).toBe("a_b");
      expect(sanitizeTsIdentifier("__group__")).toBe("group");
      expect(sanitizeTsIdentifier("123id", "rule")).toBe("rule_123id");
      expect(sanitizeTsIdentifier("", "rule")).toBe("rule");
    });
  });

  describe("generateVitestSource", () => {
    it("produces a complete describe/it suite with imports and beforeEach", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant ACCT_001",
          "  (severity high)",
          '  (description "balance must equal sum of buckets")',
          "  (assert (eq (path account balance) 100)))",
          "(invariant ACCT_002",
          "  (severity high)",
          '  (description "balance is positive")',
          "  (assert (gt (path account balance) 0)))",
        ].join("\n"),
      });

      const source = generateVitestSource(contract);

      expect(source).toContain('import { describe, it, expect, beforeEach } from "vitest";');
      expect(source).toContain('import { steleContext } from "./conftest.js";');
      expect(source).toContain('import * as runtime from "./_stele_runtime.js";');
      expect(source).toContain('import type { SteleContext } from "./_stele_runtime.js";');
      expect(source).toContain('describe("Stele Contract", () => {');
      expect(source).toContain("let ctx: SteleContext;");
      expect(source).toContain("beforeEach(() => {");
      expect(source).toContain("ctx = steleContext;");
      expect(source).toContain('it("ACCT_001", () => {');
      expect(source).toContain('it("ACCT_002", () => {');
      expect(source).toContain(
        'expect(runtime.steleEq(runtime.steleGetPath(ctx, ["account", "balance"]), 100)).toBe(true);',
      );
      expect(source).toContain(
        'expect(runtime.steleGt(runtime.steleGetPath(ctx, ["account", "balance"]), 0)).toBe(true);',
      );
    });

    it("disambiguates colliding sanitized invariant ids", async () => {
      const contract = await createContract({
        "main.stele": [
          "(invariant A-B",
          "  (severity high)",
          '  (description "hyphenated id")',
          "  (assert (eq 1 1)))",
          "(invariant A_B",
          "  (severity high)",
          '  (description "underscored id")',
          "  (assert (eq 1 1)))",
        ].join("\n"),
      });

      const source = generateVitestSource(contract);
      expect(source).toContain('it("A_B", () => {');
      expect(source).toContain('it("A_B_2", () => {');
    });

    it("emits an it.skip placeholder when the contract has no invariants", async () => {
      const contract = await createContract({
        "main.stele": "; intentionally empty\n",
      });
      const source = generateVitestSource(contract);
      expect(source).toContain("it.skip(");
    });

    it("emits checker invocations via runtime.steleCallChecker", async () => {
      const checkerContract = await createContract({
        "main.stele": [
          "(checker my-check (description \"test\"))",
          "(invariant CHECK_RULE",
          "  (severity high)",
          '  (description "uses checker")',
          '  (uses-checker my-check (account-id "ACC-1")))',
        ].join("\n"),
      });
      const source = generateVitestSource(checkerContract);
      expect(source).toContain('runtime.steleCallChecker("my-check"');
      expect(source).toContain('"account-id": "ACC-1"');
      expect(source).toContain("expect(stele_checker_result.passed,");
    });

    it("emits when guards as early-return", async () => {
      const whenContract = await createContract({
        "main.stele": [
          "(invariant WHEN_GUARD",
          "  (severity medium)",
          '  (description "guard via when")',
          "  (when (gt (path account balance) 0))",
          "  (assert (eq (path account label) null)))",
        ].join("\n"),
      });
      const source = generateVitestSource(whenContract);
      expect(source).toContain("if (!runtime.steleGt");
      expect(source).toContain("return;");
      expect(source).toContain('expect(runtime.steleEq(runtime.steleGetPath(ctx, ["account", "label"]), null)).toBe(true);');
    });
  });

  describe("quantifier operators (Phase C)", () => {
    it("translates forall with binding and recovers predicate source", () => {
      const out = translateExpression(
        parseExpression("(forall txn (collection orders) (gt (path txn amount) 0))"),
      );
      expect(out).toBe(
        'runtime.steleForall(runtime.steleGetPath(ctx, ["orders"]), (txn: unknown) => runtime.steleGt(runtime.steleGetPath(txn, ["amount"]), 0), "(gt (path txn amount) 0)")',
      );
    });

    it("translates exists with binding", () => {
      const out = translateExpression(
        parseExpression("(exists item (collection items) (eq (path item id) \"a\"))"),
      );
      expect(out).toContain("runtime.steleExists(");
      expect(out).toContain("(item: unknown) =>");
      expect(out).toContain('"(eq (path item id) \\"a\\")"');
    });

    it("translates where with binding", () => {
      const out = translateExpression(
        parseExpression("(where x (collection items) (gt (path x val) 0))"),
      );
      expect(out).toContain("runtime.steleWhere(");
      expect(out).toContain("(x: unknown) =>");
    });

    it("translates none with binding", () => {
      const out = translateExpression(
        parseExpression("(none flag (collection flags) (eq flag true))"),
      );
      expect(out).toContain("runtime.steleNone(");
      expect(out).toContain("(flag: unknown) =>");
    });

    it("rejects forall without binding identifier with E0603", () => {
      // First arg is not an identifier.
      expect(() =>
        translateExpression(parseExpression('(forall "x" (collection items) true)')),
      ).toThrowError(SteleError);
      try {
        translateExpression(parseExpression('(forall "x" (collection items) true)'));
      } catch (error) {
        expect((error as SteleError).code).toBe("E0603");
      }
    });

    it("rejects forall with wrong arity", () => {
      expect(() =>
        translateExpression(parseExpression("(forall x (collection items))")),
      ).toThrowError(SteleError);
    });

    it("introduces nested-scope bindings without leaking outward", () => {
      // (forall a items (forall b items2 (eq a b))) — both bindings must
      // resolve correctly inside the inner predicate.
      const out = translateExpression(
        parseExpression(
          "(forall a (collection xs) (forall b (collection ys) (eq (path a v) (path b v))))",
        ),
      );
      expect(out).toContain("(a: unknown) =>");
      expect(out).toContain("(b: unknown) =>");
      expect(out).toContain('runtime.steleGetPath(a, ["v"])');
      expect(out).toContain('runtime.steleGetPath(b, ["v"])');
    });
  });

  describe("temporal operators (Phase C)", () => {
    it("translates modified to runtime.steleIsModified", () => {
      expect(translateExpression(parseExpression("(modified (path account balance))"))).toBe(
        'runtime.steleIsModified(ctx, ["account", "balance"])',
      );
    });

    it("translates state-before / state-after to runtime helpers", () => {
      expect(translateExpression(parseExpression("(state-before)"))).toBe(
        "runtime.steleStateBefore(ctx)",
      );
      expect(translateExpression(parseExpression("(state-after)"))).toBe(
        "runtime.steleStateAfter(ctx)",
      );
    });

    it("translates within to runtime.steleWithin", () => {
      expect(translateExpression(parseExpression("(within (path event timestamp) 30)"))).toBe(
        'runtime.steleWithin(runtime.steleGetPath(ctx, ["event", "timestamp"]), 30)',
      );
    });

    it("translates before / after to runtime.steleBefore / runtime.steleAfter", () => {
      expect(translateExpression(parseExpression("(before (path a) (path b))"))).toBe(
        'runtime.steleBefore(runtime.steleGetPath(ctx, ["a"]), runtime.steleGetPath(ctx, ["b"]))',
      );
      expect(translateExpression(parseExpression("(after (path a) (path b))"))).toBe(
        'runtime.steleAfter(runtime.steleGetPath(ctx, ["a"]), runtime.steleGetPath(ctx, ["b"]))',
      );
    });

    it("rejects modified without a path argument", () => {
      expect(() => translateExpression(parseExpression("(modified)"))).toThrowError(SteleError);
      expect(() => translateExpression(parseExpression("(modified 5)"))).toThrowError(SteleError);
    });

    it("rejects state-before/state-after with operands", () => {
      expect(() => translateExpression(parseExpression("(state-before 1)"))).toThrowError(
        SteleError,
      );
      expect(() => translateExpression(parseExpression("(state-after 1)"))).toThrowError(
        SteleError,
      );
    });
  });

  describe("scenario integration (Phase C)", () => {
    it("emits steleRunScenario + steleMergeContexts in the test body", async () => {
      const contract = await createContract({
        "main.stele": [
          "(scenario create-fund",
          "  (sandbox transactional)",
          "  (executor python-import)",
          "  (step open-fund",
          '    (call "tests.contract_scenarios:open_fund"',
          '      (body (object (name (gen unique-name "fund")))))',
          "    (capture fund)))",
          "(invariant FUND_BALANCE",
          "  (severity high)",
          '  (description "fund opens with zero balance")',
          "  (uses-scenario create-fund)",
          "  (assert (eq 1 1)))",
        ].join("\n"),
      });
      const source = generateVitestSource(contract);
      expect(source).toContain("runtime.steleRunScenario(");
      expect(source).toContain("runtime.steleMergeContexts(ctx, stele_scenario_context)");
      expect(source).toContain("const stele_assert_context = ");
      // The scenario literal should embed the target.
      expect(source).toContain('"target": "tests.contract_scenarios:open_fund"');
      // The scenario body should preserve the gen marker as $gen.
      expect(source).toContain('"$gen"');
    });

    it("emits checker call with translated args (boolean/number/string literals)", async () => {
      const contract = await createContract({
        "main.stele": [
          "(checker balance-change-has-transaction",
          '  (description "fixture checker"))',
          "(invariant CHECK_NEEDS_TXN",
          "  (severity high)",
          '  (description "checker call")',
          '  (uses-checker balance-change-has-transaction (account-id "ACC-1") (limit 100)))',
        ].join("\n"),
      });
      const source = generateVitestSource(contract);
      expect(source).toContain('runtime.steleCallChecker("balance-change-has-transaction"');
      expect(source).toContain('"account-id": "ACC-1"');
      expect(source).toContain('"limit": 100');
    });
  });

  describe("astToSource (Phase C predicate-source recovery)", () => {
    it("renders nested expressions with canonical spacing", async () => {
      const { astToSource } = await import("../src/translator.js");
      const node = parseExpression("(and (gt x 0) (lt x 10))");
      expect(astToSource(node)).toBe("(and (gt x 0) (lt x 10))");
    });

    it("preserves number raw form (so 1.5e-3 round-trips)", async () => {
      const { astToSource } = await import("../src/translator.js");
      const node = parseExpression("(approx-eq a b 1.5e-3)");
      expect(astToSource(node)).toBe("(approx-eq a b 1.5e-3)");
    });

    it("escapes string literals", async () => {
      const { astToSource } = await import("../src/translator.js");
      const node = parseExpression('(eq (path name) "Mr. \\"Smith\\"")');
      expect(astToSource(node)).toContain('"Mr. \\"Smith\\""');
    });
  });

  describe("runtime source", () => {
    it("contains the canonical helpers used by the translator output", () => {
      const source = getTypeScriptRuntimeSource();
      expect(source).toContain("export class SteleRuntimeError");
      expect(source).toContain("export interface SteleContext");
      expect(source).toContain("export function steleGetPath");
      expect(source).toContain("export function steleEq");
      expect(source).toContain("export function steleNeq");
      expect(source).toContain("export function steleGt");
      expect(source).toContain("export function steleGte");
      expect(source).toContain("export function steleLt");
      expect(source).toContain("export function steleLte");
      // kebab-case fallback marker in the runtime path lookup.
      expect(source).toContain("kebab-case to camelCase fallback");
    });

    it("ships every Phase B runtime helper used by the translator", () => {
      const source = getTypeScriptRuntimeSource();
      const PHASE_B_HELPERS = [
        "steleAbs",
        "steleSum",
        "steleCount",
        "steleAvg",
        "steleMin",
        "steleMax",
        "steleDistinct",
        "steleUnique",
        "steleHasLength",
        "steleIsEmpty",
        "steleExistsIn",
        "steleContains",
        "steleStartsWith",
        "steleEndsWith",
        "steleMatches",
        "steleNotNull",
        "steleBetween",
        "steleApproxEq",
      ];
      for (const helper of PHASE_B_HELPERS) {
        expect(source).toContain(`export function ${helper}`);
      }
    });

    it("ships every Phase C runtime helper used by the translator", () => {
      const source = getTypeScriptRuntimeSource();
      const PHASE_C_HELPERS = [
        "steleForall",
        "steleExists",
        "steleWhere",
        "steleNone",
        "steleIsModified",
        "steleStateBefore",
        "steleStateAfter",
        "steleWithin",
        "steleBefore",
        "steleAfter",
        "steleRunScenario",
        "steleCallChecker",
        "steleMergeContexts",
      ];
      for (const helper of PHASE_C_HELPERS) {
        expect(source).toContain(`export function ${helper}`);
      }
      expect(source).toContain("export class SteleAssertionFailed");
      expect(source).toContain("export function safeSerialize");
      expect(source).toContain("STELE_USER_ALLOWED_MODULES");
    });

    it("returns the same source on repeated calls (cached)", () => {
      expect(getTypeScriptRuntimeSource()).toBe(getTypeScriptRuntimeSource());
    });

    it("ships every EP04 batch 1 runtime helper used by the translator", () => {
      const source = getTypeScriptRuntimeSource();
      const EP04_HELPERS = [
        "steleLength",
        "steleConcat",
        "steleSortBy",
        "steleSortByDesc",
        "steleMod",
        "stelePow",
        "steleRound",
        "steleCeil",
        "steleFloor",
        "steleTrim",
        "steleLower",
        "steleUpper",
        "steleSplit",
        "steleJoin",
        "steleTypeOf",
        "steleMap",
        "steleFirst",
        "steleLast",
      ];
      for (const helper of EP04_HELPERS) {
        expect(source).toContain(`export function ${helper}`);
      }
    });
  });

  describe("EP04 batch 1: collection operators", () => {
    it("translates length via runtime.steleLength", () => {
      expect(translateExpression(parseExpression("(length (path items))"))).toBe(
        'runtime.steleLength(runtime.steleGetPath(ctx, ["items"]))',
      );
    });

    it("translates concat via variadic runtime.steleConcat", () => {
      expect(
        translateExpression(parseExpression("(concat (path a) (path b) (path c))")),
      ).toBe(
        'runtime.steleConcat(runtime.steleGetPath(ctx, ["a"]), runtime.steleGetPath(ctx, ["b"]), runtime.steleGetPath(ctx, ["c"]))',
      );
    });

    it("translates sort-by via runtime.steleSortBy with path projection", () => {
      expect(
        translateExpression(parseExpression("(sort-by (collection items) (path price))")),
      ).toBe('runtime.steleSortBy(runtime.steleGetPath(ctx, ["items"]), ["price"])');
    });

    it("translates sort-by-desc via runtime.steleSortByDesc", () => {
      expect(
        translateExpression(parseExpression("(sort-by-desc (collection items) (path price))")),
      ).toBe('runtime.steleSortByDesc(runtime.steleGetPath(ctx, ["items"]), ["price"])');
    });

    it("rejects (length) with no operand", () => {
      expect(() => translateExpression(parseExpression("(length)"))).toThrowError(SteleError);
    });

    it("rejects (concat) with no operands", () => {
      expect(() => translateExpression(parseExpression("(concat)"))).toThrowError(SteleError);
    });

    it("rejects (sort-by) with non-path projection", () => {
      expect(() =>
        translateExpression(parseExpression("(sort-by (collection items) 5)")),
      ).toThrowError(SteleError);
    });
  });

  describe("EP04 batch 1: arithmetic operators", () => {
    it("translates mod via runtime.steleMod", () => {
      expect(translateExpression(parseExpression("(mod 7 3)"))).toBe("runtime.steleMod(7, 3)");
    });

    it("translates pow via runtime.stelePow", () => {
      expect(translateExpression(parseExpression("(pow 2 8)"))).toBe("runtime.stelePow(2, 8)");
    });

    it("translates round (no digits) via runtime.steleRound", () => {
      expect(translateExpression(parseExpression("(round 1.5)"))).toBe("runtime.steleRound(1.5)");
    });

    it("translates round with digits via runtime.steleRound", () => {
      expect(translateExpression(parseExpression("(round 3.14159 2)"))).toBe(
        "runtime.steleRound(3.14159, 2)",
      );
    });

    it("translates ceil / floor via runtime helpers", () => {
      expect(translateExpression(parseExpression("(ceil 1.2)"))).toBe("runtime.steleCeil(1.2)");
      expect(translateExpression(parseExpression("(floor 1.8)"))).toBe("runtime.steleFloor(1.8)");
    });

    it("rejects (mod) with one operand", () => {
      expect(() => translateExpression(parseExpression("(mod 7)"))).toThrowError(SteleError);
    });

    it("rejects (round) with no operand", () => {
      expect(() => translateExpression(parseExpression("(round)"))).toThrowError(SteleError);
    });
  });

  describe("EP04 batch 1: string operators", () => {
    it("translates trim / lower / upper via runtime helpers", () => {
      expect(translateExpression(parseExpression('(trim " hi ")'))).toBe('runtime.steleTrim(" hi ")');
      expect(translateExpression(parseExpression('(lower "ABC")'))).toBe('runtime.steleLower("ABC")');
      expect(translateExpression(parseExpression('(upper "abc")'))).toBe('runtime.steleUpper("abc")');
    });

    it("translates split via runtime.steleSplit", () => {
      expect(translateExpression(parseExpression('(split "a,b,c" ",")'))).toBe(
        'runtime.steleSplit("a,b,c", ",")',
      );
    });

    it("translates join via runtime.steleJoin", () => {
      expect(translateExpression(parseExpression('(join (path tags) ",")'))).toBe(
        'runtime.steleJoin(runtime.steleGetPath(ctx, ["tags"]), ",")',
      );
    });

    it("rejects (trim) with two operands", () => {
      expect(() => translateExpression(parseExpression('(trim "a" "b")'))).toThrowError(SteleError);
    });
  });

  describe("EP04 batch 1: data access and FP", () => {
    it("translates type-of via runtime.steleTypeOf", () => {
      expect(translateExpression(parseExpression("(type-of (path x))"))).toBe(
        'runtime.steleTypeOf(runtime.steleGetPath(ctx, ["x"]))',
      );
    });

    it("translates map via runtime.steleMap with path projection", () => {
      expect(translateExpression(parseExpression("(map (collection items) (path price))"))).toBe(
        'runtime.steleMap(runtime.steleGetPath(ctx, ["items"]), ["price"])',
      );
    });

    it("translates first / last via runtime helpers", () => {
      expect(translateExpression(parseExpression("(first (collection items))"))).toBe(
        'runtime.steleFirst(runtime.steleGetPath(ctx, ["items"]))',
      );
      expect(translateExpression(parseExpression("(last (collection items))"))).toBe(
        'runtime.steleLast(runtime.steleGetPath(ctx, ["items"]))',
      );
    });

    it("translates filter as a strict alias of where", () => {
      const filterOut = translateExpression(
        parseExpression("(filter x (collection items) (gt (path x val) 0))"),
      );
      const whereOut = translateExpression(
        parseExpression("(where x (collection items) (gt (path x val) 0))"),
      );
      // Spec requires byte-identical generated code for filter/where.
      expect(filterOut).toBe(whereOut);
      expect(filterOut).toContain("runtime.steleWhere(");
    });

    it("rejects (map) with non-path projection", () => {
      expect(() =>
        translateExpression(parseExpression("(map (collection items) 5)")),
      ).toThrowError(SteleError);
    });

    it("rejects (first) with no operand", () => {
      expect(() => translateExpression(parseExpression("(first)"))).toThrowError(SteleError);
    });
  });

  describe("field operator", () => {
    it("translates field as path extension: (field (path account) cash)", () => {
      expect(translateExpression(parseExpression("(field (path account) cash)"))).toBe(
        'runtime.steleGetPath(ctx, ["account", "cash"])',
      );
    });

    it("translates field with multi-segment path: (field (path account nested) val)", () => {
      expect(translateExpression(parseExpression("(field (path account nested) val)"))).toBe(
        'runtime.steleGetPath(ctx, ["account", "nested", "val"])',
      );
    });

    it("translates field with bound variable path inside quantifier", () => {
      const out = translateExpression(
        parseExpression("(forall txn (collection orders) (gt (field (path txn) amount) 0))"),
      );
      expect(out).toBe(
        'runtime.steleForall(runtime.steleGetPath(ctx, ["orders"]), (txn: unknown) => runtime.steleGt(runtime.steleGetPath(txn, ["amount"]), 0), "(gt (field (path txn) amount) 0)")',
      );
    });

    it("rejects (field) with wrong arity", () => {
      expect(() => translateExpression(parseExpression("(field (path x))"))).toThrowError(SteleError);
      expect(() => translateExpression(parseExpression("(field (path x) a b)"))).toThrowError(SteleError);
    });

    it("rejects (field) when first arg is not a path expression", () => {
      expect(() => translateExpression(parseExpression("(field 5 cash)"))).toThrowError(SteleError);
      try {
        translateExpression(parseExpression("(field 5 cash)"));
      } catch (error) {
        expect((error as SteleError).code).toBe("E0603");
      }
    });
  });

  describe("in operator", () => {
    it("translates in via runtime.steleExistsIn", () => {
      expect(
        translateExpression(parseExpression('(in "alice" (path users))')),
      ).toBe('runtime.steleExistsIn("alice", runtime.steleGetPath(ctx, ["users"]))');
    });

    it("translates in with path value", () => {
      expect(
        translateExpression(parseExpression('(in (path account id) (path allowed-ids))')),
      ).toBe('runtime.steleExistsIn(runtime.steleGetPath(ctx, ["account", "id"]), runtime.steleGetPath(ctx, ["allowed-ids"]))');
    });

    it("translates in identically to exists-in", () => {
      const inOut = translateExpression(
        parseExpression('(in "alice" (path users))'),
      );
      const existsInOut = translateExpression(
        parseExpression('(exists-in "alice" (path users))'),
      );
      expect(inOut).toBe(existsInOut);
    });

    it("rejects (in) with wrong arity", () => {
      expect(() => translateExpression(parseExpression('(in "alice")'))).toThrowError(SteleError);
      expect(() => translateExpression(parseExpression("(in)"))).toThrowError(SteleError);
    });
  });

  describe("json-path operator", () => {
    it("translates json-path via runtime.steleJsonPath", () => {
      expect(
        translateExpression(parseExpression('(json-path (path data) "accounts.balance")')),
      ).toBe(
        'runtime.steleJsonPath(runtime.steleGetPath(ctx, ["data"]), "accounts.balance")',
      );
    });

    it("translates json-path with wildcard array access", () => {
      expect(
        translateExpression(parseExpression('(json-path (path data) "accounts[*].name")')),
      ).toBe(
        'runtime.steleJsonPath(runtime.steleGetPath(ctx, ["data"]), "accounts[*].name")',
      );
    });
  });

  describe("decimal-eq operator", () => {
    it("translates decimal-eq via runtime.steleDecimalEq", () => {
      expect(
        translateExpression(parseExpression("(decimal-eq (path amount) 1234.56)")),
      ).toBe(
        "runtime.steleDecimalEq(runtime.steleGetPath(ctx, [\"amount\"]), 1234.56)",
      );
    });
  });
});

async function createContract(files: Record<string, string>): Promise<Contract> {
  const directory = await mkdtemp(join(tmpdir(), "stele-backend-typescript-"));
  tempDirs.push(directory);

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(directory, relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }),
  );

  return loadContract(join(directory, "main.stele"));
}

function parseExpression(source: string): AstNode {
  const parsed = parseFile(`(assert ${source})`, "<translator-test>");
  const assertNode = parsed.body[0];

  expect(assertNode).toMatchObject({
    kind: "list",
    head: "assert",
  });

  return (assertNode as Extract<AstNode, { kind: "list" }>).items[0]!;
}
