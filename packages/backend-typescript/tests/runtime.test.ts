import { describe, it, expect } from "vitest";
import {
  SteleAssertionFailed,
  SteleRuntimeError,
  type SteleContext,
  safeSerialize,
  steleAbs,
  steleAdd,
  steleAfter,
  steleApproxEq,
  steleAvg,
  steleBefore,
  steleBetween,
  steleCallChecker,
  steleCeil,
  steleConcat,
  steleContains,
  steleCount,
  steleDistinct,
  steleDiv,
  steleEndsWith,
  steleExists,
  steleExistsIn,
  steleFirst,
  steleFloor,
  steleForall,
  steleHasLength,
  steleIsEmpty,
  steleIsModified,
  steleJoin,
  steleLast,
  steleLength,
  steleLower,
  steleMap,
  steleMatches,
  steleMax,
  steleMergeContexts,
  steleMin,
  steleMod,
  steleMul,
  steleNeg,
  steleNone,
  steleNotNull,
  stelePow,
  steleRound,
  steleRunScenario,
  steleSortBy,
  steleSortByDesc,
  steleSplit,
  steleStartsWith,
  steleStateAfter,
  steleStateBefore,
  steleSub,
  steleSum,
  steleTrim,
  steleTypeOf,
  steleUnique,
  steleUpper,
  steleWhere,
  steleWithin,
  STELE_ALLOWED_IMPORTS,
  STELE_BLOCKED_IMPORTS,
  STELE_USER_ALLOWED_MODULES,
  assertImportAllowed,
} from "../src/runtime/_stele_runtime.js";

describe("@stele/backend-typescript runtime helpers", () => {
  describe("arithmetic helpers", () => {
    it("steleAbs returns absolute value for negative numbers", () => {
      expect(steleAbs(-3)).toBe(3);
      expect(steleAbs(0)).toBe(0);
      expect(steleAbs(7.25)).toBe(7.25);
    });

    it("steleAbs throws SteleRuntimeError on non-numeric input", () => {
      expect(() => steleAbs("hi")).toThrow(SteleRuntimeError);
      expect(() => steleAbs(null)).toThrow(SteleRuntimeError);
      expect(() => steleAbs(NaN)).toThrow(SteleRuntimeError);
    });

    it("steleAdd / steleMul / steleSub / steleDiv / steleNeg compute and coerce", () => {
      expect(steleAdd(1, 2, 3)).toBe(6);
      expect(steleMul(2, 3, 4)).toBe(24);
      expect(steleSub(10, 4)).toBe(6);
      expect(steleDiv(10, 4)).toBe(2.5);
      expect(steleNeg(7)).toBe(-7);
    });

    it("arithmetic helpers throw on non-numeric operands", () => {
      expect(() => steleAdd(1, "x" as unknown, 3)).toThrow(SteleRuntimeError);
      expect(() => steleMul(1, null)).toThrow(SteleRuntimeError);
      expect(() => steleSub("a" as unknown, 1)).toThrow(SteleRuntimeError);
      expect(() => steleDiv(1, undefined)).toThrow(SteleRuntimeError);
      expect(() => steleNeg(NaN)).toThrow(SteleRuntimeError);
    });

    it("steleAdd / steleMul reject fewer than two operands", () => {
      expect(() => steleAdd(1)).toThrow(SteleRuntimeError);
      expect(() => steleMul(1)).toThrow(SteleRuntimeError);
    });
  });

  describe("aggregate helpers", () => {
    it("steleSum totals an array", () => {
      expect(steleSum([1, 2, 3])).toBe(6);
      expect(steleSum([])).toBe(0);
    });

    it("steleSum with projection sums a path-projected field", () => {
      expect(steleSum([{ price: 5 }, { price: 10 }], ["price"])).toBe(15);
    });

    it("steleSum throws on non-array", () => {
      expect(() => steleSum("not an array")).toThrow(SteleRuntimeError);
    });

    it("steleSum throws on non-numeric element", () => {
      expect(() => steleSum([1, "x", 3])).toThrow(SteleRuntimeError);
    });

    it("steleCount returns array length", () => {
      expect(steleCount([1, 2, 3])).toBe(3);
      expect(steleCount([])).toBe(0);
    });

    it("steleCount throws on non-array", () => {
      expect(() => steleCount({ a: 1 })).toThrow(SteleRuntimeError);
    });

    it("steleAvg averages values; empty -> 0", () => {
      expect(steleAvg([2, 4, 6])).toBe(4);
      expect(steleAvg([])).toBe(0);
      expect(steleAvg([{ x: 10 }, { x: 30 }], ["x"])).toBe(20);
    });

    it("steleMin / steleMax return the extremes", () => {
      expect(steleMin([3, 1, 2])).toBe(1);
      expect(steleMax([3, 1, 2])).toBe(3);
      expect(steleMin([{ p: 5 }, { p: 1 }, { p: 3 }], ["p"])).toBe(1);
      expect(steleMax([{ p: 5 }, { p: 1 }, { p: 3 }], ["p"])).toBe(5);
    });

    it("steleMin / steleMax throw on empty collections", () => {
      expect(() => steleMin([])).toThrow(SteleRuntimeError);
      expect(() => steleMax([])).toThrow(SteleRuntimeError);
    });

    it("steleDistinct removes duplicates while preserving order", () => {
      expect(steleDistinct([1, 2, 2, 3, 1])).toEqual([1, 2, 3]);
      expect(steleDistinct(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
      expect(steleDistinct([{ id: 1 }, { id: 2 }, { id: 1 }], ["id"])).toEqual([1, 2]);
    });

    it("steleUnique returns true iff all values are unique", () => {
      expect(steleUnique([1, 2, 3])).toBe(true);
      expect(steleUnique([1, 1, 2])).toBe(false);
      expect(steleUnique([{ id: 1 }, { id: 2 }], ["id"])).toBe(true);
      expect(steleUnique([{ id: 1 }, { id: 1 }], ["id"])).toBe(false);
    });

    it("steleHasLength compares the natural length of arrays/strings/objects", () => {
      expect(steleHasLength([1, 2, 3], 3)).toBe(true);
      expect(steleHasLength([1, 2, 3], 5)).toBe(false);
      expect(steleHasLength("hi", 2)).toBe(true);
      expect(steleHasLength({ a: 1, b: 2 }, 2)).toBe(true);
    });

    it("steleIsEmpty returns true on empty arrays, strings, objects", () => {
      expect(steleIsEmpty([])).toBe(true);
      expect(steleIsEmpty("")).toBe(true);
      expect(steleIsEmpty({})).toBe(true);
      expect(steleIsEmpty([0])).toBe(false);
      expect(steleIsEmpty("x")).toBe(false);
      expect(steleIsEmpty({ a: 1 })).toBe(false);
    });

    it("steleIsEmpty throws on primitives", () => {
      expect(() => steleIsEmpty(42)).toThrow(SteleRuntimeError);
      expect(() => steleIsEmpty(null)).toThrow(SteleRuntimeError);
    });

    it("steleExistsIn handles arrays / strings / objects", () => {
      expect(steleExistsIn(2, [1, 2, 3])).toBe(true);
      expect(steleExistsIn(4, [1, 2, 3])).toBe(false);
      expect(steleExistsIn("ll", "hello")).toBe(true);
      expect(steleExistsIn("z", "hello")).toBe(false);
      expect(steleExistsIn("a", { a: 1, b: 2 })).toBe(true);
      expect(steleExistsIn("c", { a: 1, b: 2 })).toBe(false);
    });

    it("steleExistsIn throws on unsupported container types", () => {
      expect(() => steleExistsIn(1, 5 as unknown)).toThrow(SteleRuntimeError);
    });
  });

  describe("string helpers", () => {
    it("steleContains tests substring containment", () => {
      expect(steleContains("hello world", "world")).toBe(true);
      expect(steleContains("hello", "z")).toBe(false);
    });

    it("steleStartsWith / steleEndsWith", () => {
      expect(steleStartsWith("Mr. Smith", "Mr.")).toBe(true);
      expect(steleStartsWith("Smith", "Mr.")).toBe(false);
      expect(steleEndsWith("file.csv", ".csv")).toBe(true);
      expect(steleEndsWith("file.csv", ".tsv")).toBe(false);
    });

    it("steleMatches uses re.search semantics (substring, not anchored)", () => {
      expect(steleMatches("hello world", "world")).toBe(true);
      expect(steleMatches("hello world", "^hello")).toBe(true);
      expect(steleMatches("hello world", "world$")).toBe(true);
      expect(steleMatches("hello", "[A-Z]+")).toBe(false);
      expect(steleMatches("HELLO", "[A-Z]+")).toBe(true);
    });

    it("steleMatches rejects lookbehind", () => {
      expect(() => steleMatches("abc", "(?<=a)b")).toThrow(SteleRuntimeError);
      expect(() => steleMatches("abc", "(?<!a)b")).toThrow(SteleRuntimeError);
    });

    it("steleMatches rejects invalid regex", () => {
      expect(() => steleMatches("abc", "[unterminated")).toThrow(SteleRuntimeError);
    });

    it("string helpers throw on non-string operands", () => {
      expect(() => steleContains(42 as unknown, "z")).toThrow(SteleRuntimeError);
      expect(() => steleStartsWith("x", 1 as unknown)).toThrow(SteleRuntimeError);
      expect(() => steleEndsWith(null, ".csv")).toThrow(SteleRuntimeError);
      expect(() => steleMatches(7 as unknown, ".+")).toThrow(SteleRuntimeError);
    });
  });

  describe("control-flow helpers", () => {
    it("steleNotNull distinguishes null/undefined from falsy values", () => {
      expect(steleNotNull(0)).toBe(true);
      expect(steleNotNull("")).toBe(true);
      expect(steleNotNull(false)).toBe(true);
      expect(steleNotNull(null)).toBe(false);
      expect(steleNotNull(undefined)).toBe(false);
    });

    it("steleBetween is inclusive on both ends", () => {
      expect(steleBetween(5, 1, 10)).toBe(true);
      expect(steleBetween(1, 1, 10)).toBe(true);
      expect(steleBetween(10, 1, 10)).toBe(true);
      expect(steleBetween(0, 1, 10)).toBe(false);
      expect(steleBetween(11, 1, 10)).toBe(false);
    });

    it("steleApproxEq compares within tolerance", () => {
      expect(steleApproxEq(1.0, 1.0001, 0.001)).toBe(true);
      expect(steleApproxEq(1.0, 1.0001, 1e-6)).toBe(false);
      expect(steleApproxEq(0.1 + 0.2, 0.3, 1e-9)).toBe(true);
    });
  });

  describe("Phase C — quantifier helpers", () => {
    it("steleForall returns true on empty + all-pass collections", () => {
      expect(steleForall([], () => false, "<empty>")).toBe(true);
      expect(steleForall([1, 2, 3], (item) => (item as number) > 0, "(gt item 0)")).toBe(true);
    });

    it("steleForall throws SteleAssertionFailed with witness on first failure", () => {
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
      try {
        steleForall(items, (item) => (item as { id: number }).id !== 2, "(neq (path id) 2)");
        throw new Error("expected SteleAssertionFailed");
      } catch (error) {
        expect(error).toBeInstanceOf(SteleAssertionFailed);
        const witness = (error as SteleAssertionFailed).witness;
        expect(witness.operator).toBe("forall");
        expect(witness.collection_size).toBe(3);
        expect(witness.failed_at_index).toBe(1);
        expect(witness.predicate_source).toBe("(neq (path id) 2)");
        expect(witness.failed_item).toEqual({ id: 2 });
        expect(witness.truncated).toBe(false);
      }
    });

    it("steleForall throws SteleRuntimeError on non-array", () => {
      expect(() => steleForall("nope", () => true, "<x>")).toThrow(SteleRuntimeError);
    });

    it("steleExists returns true on first match", () => {
      const result = steleExists([1, 2, 3], (item) => (item as number) === 2, "(eq item 2)");
      expect(result).toBe(true);
    });

    it("steleExists throws SteleAssertionFailed when no element matches", () => {
      try {
        steleExists([1, 2, 3], (item) => (item as number) === 99, "(eq item 99)");
        throw new Error("expected SteleAssertionFailed");
      } catch (error) {
        expect(error).toBeInstanceOf(SteleAssertionFailed);
        const witness = (error as SteleAssertionFailed).witness;
        expect(witness.operator).toBe("exists");
        expect(witness.collection_size).toBe(3);
        expect(witness.failed_at_index).toBeUndefined();
        expect(witness.failed_item).toBeUndefined();
        expect(witness.predicate_source).toBe("(eq item 99)");
      }
    });

    it("steleWhere returns a filtered subset (no assertion)", () => {
      const result = steleWhere(
        [1, 2, 3, 4],
        (item) => (item as number) % 2 === 0,
        "(eq (mod item 2) 0)",
      );
      expect(result).toEqual([2, 4]);
    });

    it("steleNone returns true when no item matches", () => {
      expect(steleNone([1, 3, 5], (item) => (item as number) % 2 === 0, "(eq item even)")).toBe(true);
    });

    it("steleNone throws SteleAssertionFailed on first matching item", () => {
      try {
        steleNone(
          [{ tag: "ok" }, { tag: "bad" }, { tag: "ok" }],
          (item) => (item as { tag: string }).tag === "bad",
          '(eq (path tag) "bad")',
        );
        throw new Error("expected SteleAssertionFailed");
      } catch (error) {
        expect(error).toBeInstanceOf(SteleAssertionFailed);
        const witness = (error as SteleAssertionFailed).witness;
        expect(witness.operator).toBe("none");
        expect(witness.failed_at_index).toBe(1);
        expect(witness.failed_item).toEqual({ tag: "bad" });
      }
    });

    it("steleForall surfaces predicate-thrown SteleRuntimeError as-is", () => {
      expect(() =>
        steleForall(
          [1, 2, 3],
          () => {
            throw new SteleRuntimeError("bang");
          },
          "<src>",
        ),
      ).toThrow(SteleRuntimeError);
    });

    it("steleForall wraps non-Stele predicate errors as SteleRuntimeError", () => {
      try {
        steleForall(
          [1, 2, 3],
          () => {
            throw new TypeError("oops");
          },
          "<src>",
        );
        throw new Error("expected SteleRuntimeError");
      } catch (error) {
        expect(error).toBeInstanceOf(SteleRuntimeError);
        expect((error as SteleRuntimeError).message).toContain("predicate threw");
        expect((error as SteleRuntimeError).message).toContain("oops");
      }
    });
  });

  describe("Phase C — safeSerialize", () => {
    it("respects max_depth and sets truncated", () => {
      const deep = { a: { b: { c: { d: { e: 1 } } } } };
      const { serialized, truncated } = safeSerialize(deep, 2);
      expect(serialized).toEqual({ a: { b: { c: "<depth-limit>" } } });
      expect(truncated).toBe(true);
    });

    it("returns the original tree when shallow enough", () => {
      const { serialized, truncated } = safeSerialize({ a: 1, b: [1, 2, 3] }, 5);
      expect(serialized).toEqual({ a: 1, b: [1, 2, 3] });
      expect(truncated).toBe(false);
    });

    it("redacts password / token / secret / api_key keys (case insensitive)", () => {
      const { serialized } = safeSerialize(
        { Password: "x", token: "y", SECRET: "z", api_key: "w", api_KEY: "u", apiKey: "v", normal: 1 },
        3,
      );
      expect(serialized).toEqual({
        Password: "<redacted>",
        token: "<redacted>",
        SECRET: "<redacted>",
        api_key: "<redacted>",
        api_KEY: "<redacted>",
        apiKey: "<redacted>",
        normal: 1,
      });
    });

    it("trims arrays exceeding 100 items", () => {
      const big = Array.from({ length: 200 }, (_, i) => i);
      const { serialized, truncated } = safeSerialize(big, 5);
      expect(Array.isArray(serialized)).toBe(true);
      expect((serialized as number[]).length).toBe(100);
      expect(truncated).toBe(true);
    });

    it("substitutes a stub when JSON length exceeds 64 KB", () => {
      const big = "x".repeat(70_000);
      const { serialized, truncated } = safeSerialize({ field: big }, 3);
      expect(truncated).toBe(true);
      expect(serialized).toMatchObject({ _truncated: true });
    });

    it("accepts custom redaction patterns", () => {
      const { serialized } = safeSerialize(
        { ssn: "123", custom_pii: "abc", normal: 1 },
        3,
        [/ssn/i, /pii/i],
      );
      expect(serialized).toEqual({ ssn: "<redacted>", custom_pii: "<redacted>", normal: 1 });
    });
  });

  describe("Phase C — temporal helpers", () => {
    it("steleStateBefore / steleStateAfter throw when missing", () => {
      const ctx: SteleContext = { foo: 1 };
      expect(() => steleStateBefore(ctx)).toThrow(SteleRuntimeError);
      expect(() => steleStateAfter(ctx)).toThrow(SteleRuntimeError);
    });

    it("steleStateBefore returns the snapshot object when present", () => {
      const ctx: SteleContext = { "state-before": { account: { balance: 100 } } };
      const value = steleStateBefore(ctx);
      expect(value).toEqual({ account: { balance: 100 } });
    });

    it("steleIsModified compares paths in state-before vs state-after", () => {
      const ctx: SteleContext = {
        "state-before": { account: { balance: 100, status: "active" } },
        "state-after": { account: { balance: 90, status: "active" } },
      };
      expect(steleIsModified(ctx, ["account", "balance"])).toBe(true);
      expect(steleIsModified(ctx, ["account", "status"])).toBe(false);
    });

    it("steleIsModified handles 'missing on one side' as modified", () => {
      const ctx: SteleContext = {
        "state-before": { account: { balance: 100 } },
        "state-after": { account: { balance: 100, locked: true } },
      };
      expect(steleIsModified(ctx, ["account", "locked"])).toBe(true);
    });

    it("steleBefore / steleAfter compare numbers, dates, ISO strings", () => {
      expect(steleBefore(1, 2)).toBe(true);
      expect(steleAfter(2, 1)).toBe(true);
      expect(steleBefore(new Date("2025-01-01"), new Date("2026-01-01"))).toBe(true);
      expect(steleAfter("2026-05-08", "2025-05-08")).toBe(true);
      expect(() => steleBefore({} as unknown, 1)).toThrow(SteleRuntimeError);
    });

    it("steleWithin checks (now - event) < duration*1000", () => {
      const oneMinuteAgo = Date.now() - 60_000;
      expect(steleWithin(oneMinuteAgo, 120)).toBe(true);
      expect(steleWithin(oneMinuteAgo, 30)).toBe(false);
      expect(() => steleWithin("nope" as unknown, 30)).toThrow(SteleRuntimeError);
      expect(() => steleWithin(0, "x" as unknown)).toThrow(SteleRuntimeError);
    });
  });

  describe("Phase C — checker", () => {
    it("steleCallChecker dispatches to the registry by name", () => {
      const ctx: SteleContext = {
        _stele_checkers: {
          "demo-check": (_, args) => {
            if (typeof args["account-id"] !== "string") {
              return { passed: false, message: "missing account-id" };
            }
            return true;
          },
        },
      };
      const ok = steleCallChecker("demo-check", ctx, { "account-id": "ACC-1" });
      expect(ok.passed).toBe(true);
      expect(ok.message).toBe(null);
      const bad = steleCallChecker("demo-check", ctx, {});
      expect(bad.passed).toBe(false);
      expect(bad.message).toBe("missing account-id");
    });

    it("steleCallChecker throws when registry or checker is missing", () => {
      const empty: SteleContext = {};
      expect(() => steleCallChecker("anything", empty)).toThrow(SteleRuntimeError);
      const partial: SteleContext = { _stele_checkers: {} };
      expect(() => steleCallChecker("anything", partial)).toThrow(SteleRuntimeError);
    });
  });

  describe("Phase C — scenario", () => {
    it("steleRunScenario invokes step targets and captures results", () => {
      const ctx: SteleContext = {
        _stele_scenario_targets: {
          "tests.contract_scenarios:open_fund": (body) => ({ id: "fund-1", body }),
          "tests.contract_scenarios:get_pnl": (body) => ({ value: 50, ref: body }),
        } as Record<string, (body: unknown, ctx: SteleContext) => unknown>,
      };
      const scenario = {
        id: "demo",
        executor: "python-import",
        sandbox: "transactional",
        steps: [
          {
            kind: "step" as const,
            id: "open",
            capture: "fund",
            call: { target: "tests.contract_scenarios:open_fund", body: { name: "f1" } },
          },
          {
            kind: "capture-state" as const,
            capture: "pnl",
            call: {
              target: "tests.contract_scenarios:get_pnl",
              body: { "fund-id": { $ref: ["fund", "id"] } },
            },
          },
        ],
      };
      const out = steleRunScenario(scenario, ctx) as Record<string, unknown>;
      expect(out.fund).toEqual({ id: "fund-1", body: { name: "f1" } });
      expect((out.pnl as { value: number; ref: { "fund-id": string } }).ref["fund-id"]).toBe(
        "fund-1",
      );
    });

    it("steleRunScenario throws when target not registered", () => {
      const ctx: SteleContext = { _stele_scenario_targets: {} as Record<string, never> };
      expect(() =>
        steleRunScenario(
          { steps: [{ kind: "step", id: "x", capture: "y", call: { target: "missing:fn" } }] },
          ctx,
        ),
      ).toThrow(SteleRuntimeError);
    });

    it("steleRunScenario invokes sandbox enter/exit", () => {
      const events: string[] = [];
      const ctx: SteleContext = {
        _stele_scenario_targets: {
          "demo:fn": () => {
            events.push("call");
            return null;
          },
        } as Record<string, (body: unknown, ctx: SteleContext) => unknown>,
      };
      const sandbox = {
        enter() {
          events.push("enter");
        },
        exit() {
          events.push("exit");
        },
      };
      steleRunScenario(
        { steps: [{ kind: "step", id: "x", capture: "y", call: { target: "demo:fn" } }] },
        ctx,
        sandbox,
      );
      expect(events).toEqual(["enter", "call", "exit"]);
    });

    it("steleMergeContexts performs last-write-wins overlay", () => {
      const merged = steleMergeContexts({ a: 1, b: 2 }, { b: 3, c: 4 });
      expect(merged).toEqual({ a: 1, b: 3, c: 4 });
    });
  });

  describe("Phase C — import allowlist", () => {
    it("STELE_ALLOWED_IMPORTS contains exactly Math + JSON", () => {
      expect(STELE_ALLOWED_IMPORTS.has("Math")).toBe(true);
      expect(STELE_ALLOWED_IMPORTS.has("JSON")).toBe(true);
      expect(STELE_ALLOWED_IMPORTS.size).toBe(2);
    });

    it("STELE_USER_ALLOWED_MODULES mirrors Python prefixes", () => {
      expect(STELE_USER_ALLOWED_MODULES).toContain("tests/contract_scenarios");
      expect(STELE_USER_ALLOWED_MODULES).toContain("tests/contract");
      expect(STELE_USER_ALLOWED_MODULES).toContain("app");
    });

    it("assertImportAllowed accepts Math, JSON, app/* and rejects fs/child_process", () => {
      expect(() => assertImportAllowed("Math")).not.toThrow();
      expect(() => assertImportAllowed("JSON")).not.toThrow();
      expect(() => assertImportAllowed("app")).not.toThrow();
      expect(() => assertImportAllowed("app/services")).not.toThrow();
      expect(() => assertImportAllowed("tests/contract_scenarios/flows")).not.toThrow();
      expect(() => assertImportAllowed("fs")).toThrow(SteleRuntimeError);
      expect(() => assertImportAllowed("child_process")).toThrow(SteleRuntimeError);
      expect(() => assertImportAllowed("node:fs")).toThrow(SteleRuntimeError);
      expect(() => assertImportAllowed("random-third-party")).toThrow(SteleRuntimeError);
    });

    it("STELE_BLOCKED_IMPORTS contains the canonical Node danger list", () => {
      const expected = ["fs", "child_process", "node:fs", "node:child_process", "vm"];
      for (const mod of expected) {
        expect(STELE_BLOCKED_IMPORTS.has(mod)).toBe(true);
      }
    });
  });

  describe("EP04 batch 1: collection helpers", () => {
    it("steleLength returns array length and 0 for empty arrays", () => {
      expect(steleLength([1, 2, 3])).toBe(3);
      expect(steleLength([])).toBe(0);
    });

    it("steleLength throws SteleRuntimeError on non-collection", () => {
      expect(() => steleLength("hi")).toThrow(SteleRuntimeError);
      expect(() => steleLength(42)).toThrow(SteleRuntimeError);
      expect(() => steleLength({ a: 1 })).toThrow(SteleRuntimeError);
    });

    it("steleConcat preserves order and duplicates across collections", () => {
      expect(steleConcat([1, 2], [2, 3], [4])).toEqual([1, 2, 2, 3, 4]);
      expect(steleConcat([])).toEqual([]);
    });

    it("steleConcat rejects zero arguments and non-collection operands", () => {
      expect(() => steleConcat()).toThrow(SteleRuntimeError);
      expect(() => steleConcat([1], "bad" as unknown)).toThrow(SteleRuntimeError);
    });

    it("steleSortBy stable-sorts ascending: NaN first, null last", () => {
      const items = [
        { v: 3 },
        { v: 1 },
        { v: Number.NaN },
        { v: 2 },
        { v: null },
      ];
      const sorted = steleSortBy(items, ["v"]) as Array<{ v: number | null }>;
      expect(sorted[0]!.v).toBeNaN();
      expect(sorted.slice(1, 4).map((entry) => entry.v)).toEqual([1, 2, 3]);
      expect(sorted[4]!.v).toBeNull();
    });

    it("steleSortBy is stable for equal keys (preserves original index)", () => {
      const items = [
        { v: 1, tag: "a" },
        { v: 1, tag: "b" },
        { v: 1, tag: "c" },
      ];
      const sorted = steleSortBy(items, ["v"]) as Array<{ tag: string }>;
      expect(sorted.map((entry) => entry.tag)).toEqual(["a", "b", "c"]);
    });

    it("steleSortByDesc stable-sorts descending with NaN first and null last", () => {
      const items = [
        { v: 3 },
        { v: 1 },
        { v: Number.NaN },
        { v: 2 },
        { v: null },
      ];
      const sorted = steleSortByDesc(items, ["v"]) as Array<{ v: number | null }>;
      expect(sorted[0]!.v).toBeNaN();
      expect(sorted.slice(1, 4).map((entry) => entry.v)).toEqual([3, 2, 1]);
      expect(sorted[4]!.v).toBeNull();
    });

    it("steleSortBy compares strings lexicographically (no locale)", () => {
      const items = [{ s: "B" }, { s: "a" }, { s: "C" }];
      // ASCII byte order: capitals come before lowercase.
      const sorted = steleSortBy(items, ["s"]) as Array<{ s: string }>;
      expect(sorted.map((entry) => entry.s)).toEqual(["B", "C", "a"]);
    });
  });

  describe("EP04 batch 1: arithmetic helpers", () => {
    it("steleMod follows sign-of-divisor (Python) semantics", () => {
      expect(steleMod(-7, 3)).toBe(2);
      expect(steleMod(7, -3)).toBe(-2);
      expect(steleMod(7, 3)).toBe(1);
    });

    it("steleMod throws SteleRuntimeError on divisor of zero", () => {
      expect(() => steleMod(7, 0)).toThrow(SteleRuntimeError);
    });

    it("stelePow returns NaN on negative base with non-integer exponent", () => {
      expect(Number.isNaN(stelePow(-1, 0.5))).toBe(true);
      expect(stelePow(2, 8)).toBe(256);
    });

    it("steleRound performs banker's rounding (half to even)", () => {
      expect(steleRound(0.5)).toBe(0);
      expect(steleRound(1.5)).toBe(2);
      expect(steleRound(2.5)).toBe(2);
      expect(steleRound(3.5)).toBe(4);
      expect(steleRound(-0.5)).toBe(0);
    });

    it("steleRound respects digits parameter", () => {
      expect(steleRound(3.14159, 2)).toBeCloseTo(3.14, 5);
      expect(steleRound(3.145, 2)).toBeCloseTo(3.14, 5);
      expect(steleRound(3.155, 2)).toBeCloseTo(3.16, 5);
    });

    it("steleRound propagates NaN / Infinity", () => {
      expect(Number.isNaN(steleRound(Number.NaN))).toBe(true);
      expect(steleRound(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    });

    it("steleCeil / steleFloor handle NaN", () => {
      expect(Number.isNaN(steleCeil(Number.NaN))).toBe(true);
      expect(Number.isNaN(steleFloor(Number.NaN))).toBe(true);
      expect(steleCeil(1.2)).toBe(2);
      expect(steleFloor(1.8)).toBe(1);
    });
  });

  describe("EP04 batch 1: string helpers", () => {
    it("steleTrim strips Unicode whitespace from both ends", () => {
      expect(steleTrim("  hello  ")).toBe("hello");
      expect(steleTrim(" \thi　\n")).toBe("hi");
    });

    it("steleLower / steleUpper are locale-independent", () => {
      expect(steleLower("ABC")).toBe("abc");
      expect(steleUpper("abc")).toBe("ABC");
      // Unicode characters preserved.
      expect(steleLower("ÄÖÜ")).toBe("äöü");
    });

    it("steleSplit splits by literal separator", () => {
      expect(steleSplit("a,b,c", ",")).toEqual(["a", "b", "c"]);
      expect(steleSplit("hello", "x")).toEqual(["hello"]);
    });

    it("steleSplit throws SteleRuntimeError on empty separator", () => {
      expect(() => steleSplit("hello", "")).toThrow(SteleRuntimeError);
    });

    it("steleJoin joins string collections", () => {
      expect(steleJoin(["a", "b", "c"], ",")).toBe("a,b,c");
      expect(steleJoin([], ",")).toBe("");
    });

    it("steleJoin throws on mixed-type collections", () => {
      expect(() => steleJoin(["a", 1, "c"], ",")).toThrow(SteleRuntimeError);
    });
  });

  describe("EP04 batch 1: data access and FP", () => {
    it("steleTypeOf returns the canonical 7-value tag set", () => {
      expect(steleTypeOf(42)).toBe("number");
      expect(steleTypeOf("hi")).toBe("string");
      expect(steleTypeOf(true)).toBe("boolean");
      expect(steleTypeOf([1, 2])).toBe("collection");
      expect(steleTypeOf({ a: 1 })).toBe("object");
      expect(steleTypeOf(null)).toBe("null");
      expect(steleTypeOf(undefined)).toBe("undefined");
    });

    it("steleMap projects each item by path", () => {
      expect(
        steleMap(
          [
            { price: 10 },
            { price: 20 },
          ],
          ["price"],
        ),
      ).toEqual([10, 20]);
    });

    it("steleMap silently skips items missing the path", () => {
      const result = steleMap(
        [{ price: 10 }, { name: "no-price" }, { price: 30 }],
        ["price"],
      );
      expect(result).toEqual([10, 30]);
    });

    it("steleFirst / steleLast return endpoint elements", () => {
      expect(steleFirst([1, 2, 3])).toBe(1);
      expect(steleLast([1, 2, 3])).toBe(3);
    });

    it("steleFirst / steleLast throw SteleRuntimeError on empty collection", () => {
      expect(() => steleFirst([])).toThrow(SteleRuntimeError);
      expect(() => steleLast([])).toThrow(SteleRuntimeError);
    });
  });
});
