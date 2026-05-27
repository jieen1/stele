import { describe, it, expect, beforeEach } from "vitest";
import { steleContext } from "./conftest.js";
import * as runtime from "./_stele_runtime.js";
import type { SteleContext } from "./_stele_runtime.js";

void runtime; // helpers: steleGetPath, steleEq, steleNeq, steleGt, steleGte, steleLt, steleLte, steleAbs, steleAdd, steleSub, steleMul, steleDiv, steleNeg, steleSum, steleCount, steleAvg, steleMin, steleMax, steleDistinct, steleUnique, steleHasLength, steleIsEmpty, steleExistsIn, steleContains, steleStartsWith, steleEndsWith, steleMatches, steleNotNull, steleBetween, steleApproxEq, steleForall, steleExists, steleWhere, steleNone, steleIsModified, steleStateBefore, steleStateAfter, steleWithin, steleBefore, steleAfter, steleRunScenario, steleCallChecker, steleMergeContexts, steleLength, steleConcat, steleSortBy, steleSortByDesc, steleMod, stelePow, steleRound, steleCeil, steleFloor, steleTrim, steleLower, steleUpper, steleSplit, steleJoin, steleJsonPath, steleDecimalEq, steleTypeOf, steleMap, steleFirst, steleLast

describe("Stele Contract", () => {
  let ctx: SteleContext;
  beforeEach(() => {
    ctx = steleContext;
  });

  it("ORDER_TOTAL_POSITIVE", () => {
    expect(runtime.steleForall(runtime.steleGetPath(ctx, ["orders"]), (order: unknown) => runtime.steleGt(runtime.steleGetPath(order, ["total"]), 0), "(gt (path order total) 0)")).toBe(true);
  });

  it("ORDER_ID_PRESENT", () => {
    expect(runtime.steleForall(runtime.steleGetPath(ctx, ["orders"]), (order: unknown) => runtime.steleNotNull(runtime.steleGetPath(order, ["id"])), "(not-null (path order id))")).toBe(true);
  });

  it("USER_STATUS_ENUM", () => {
    expect(runtime.steleEq(runtime.steleGetPath(ctx, ["user", "status"]), "active") || runtime.steleEq(runtime.steleGetPath(ctx, ["user", "status"]), "suspended") || runtime.steleEq(runtime.steleGetPath(ctx, ["user", "status"]), "deleted")).toBe(true);
  });

  it("SKU_FORMAT", () => {
    const stele_checker_result = runtime.steleCallChecker("validate-sku", ctx, {});
    expect(stele_checker_result.passed, stele_checker_result.message ?? "Checker failed: validate-sku").toBe(true);
  });

  it("EMAIL_FORMAT", () => {
    const stele_checker_result = runtime.steleCallChecker("validate-email", ctx, {});
    expect(stele_checker_result.passed, stele_checker_result.message ?? "Checker failed: validate-email").toBe(true);
  });
});
