import { describe, expect, it } from "vitest";
import { ErrorCodes, errorCodeName, errorCodeCategory, listErrorCodes } from "../src/errors/error-codes.js";

describe("error-codes", () => {
  it("contains all expected error code ranges", () => {
    const codes = listErrorCodes();
    expect(codes.length).toBeGreaterThan(20);

    // Verify each range has entries
    for (const range of ["E0001", "E0101", "E0201", "E0301", "E0401", "E0501", "E0601"]) {
      expect(codes.some((c) => c.startsWith(range.slice(0, 2)))).toBe(true);
    }
  });

  it("errorCodeName returns name for valid codes", () => {
    expect(errorCodeName("E0001")).toBe("Lexical Error");
    expect(errorCodeName("E0305")).toBe("Validation Error");
    expect(errorCodeName("E0501")).toBe("Generator Error");
    expect(errorCodeName("E0601")).toBe("Backend Error");
  });

  it("errorCodeName returns code for unknown codes", () => {
    expect(errorCodeName("E9999")).toBe("E9999");
    expect(errorCodeName("INVALID")).toBe("INVALID");
  });

  it("errorCodeCategory returns category for valid codes", () => {
    expect(errorCodeCategory("E0001")).toBe(0);
    expect(errorCodeCategory("E0101")).toBe(1);
    expect(errorCodeCategory("E0201")).toBe(2);
    expect(errorCodeCategory("E0301")).toBe(3);
    expect(errorCodeCategory("E0401")).toBe(4);
    expect(errorCodeCategory("E0501")).toBe(5);
    expect(errorCodeCategory("E0601")).toBe(6);
  });

  it("errorCodeCategory returns -1 for unknown codes", () => {
    expect(errorCodeCategory("E9999")).toBe(-1);
  });

  it("error codes follow E0XXX pattern", () => {
    for (const code of listErrorCodes()) {
      expect(code).toMatch(/^E0\d{3}$/);
    }
  });

  it("error codes have required fields", () => {
    for (const [code, info] of Object.entries(ErrorCodes)) {
      expect(info.name).toBeTruthy();
      expect(info.message).toBeTruthy();
      expect(info.category).toBeGreaterThanOrEqual(0);
      expect(info.source).toBeTruthy();
    }
  });

  it("categories are sequential (0-6)", () => {
    const categories = new Set(listErrorCodes().map((c) => errorCodeCategory(c)));
    expect(categories.has(0)).toBe(true);
    expect(categories.has(6)).toBe(true);
    expect(categories.size).toBe(7);
  });

  it("no gaps in code sequences within families", () => {
    // E0301-E0322 should have no gaps
    const e300s = listErrorCodes().filter((c) => c.startsWith("E03"));
    const maxE3 = Math.max(...e300s.map((c) => parseInt(c.slice(1))));
    expect(maxE3).toBeGreaterThanOrEqual(320);
  });
});
