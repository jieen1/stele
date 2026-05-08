import { describe, expect, it } from "vitest";
import { SteleError } from "../src/errors/SteleError.js";

describe("SteleError", () => {
  it("sets name to 'SteleError'", () => {
    const error = new SteleError("E001", "parse", "bad syntax");
    expect(error.name).toBe("SteleError");
  });

  it("sets code and category", () => {
    const error = new SteleError("E42", "semantic", "type mismatch");
    expect(error.code).toBe("E42");
    expect(error.category).toBe("semantic");
  });

  it("inherits message from Error", () => {
    const error = new SteleError("E001", "parse", "unexpected token");
    expect(error.message).toBe("unexpected token");
  });

  it("is instanceof SteleError", () => {
    const error = new SteleError("E001", "parse", "bad syntax");
    expect(error).toBeInstanceOf(SteleError);
  });

  it("is instanceof Error", () => {
    const error = new SteleError("E001", "parse", "bad syntax");
    expect(error).toBeInstanceOf(Error);
  });

  it("accepts optional span, detail, and hint", () => {
    const span = { file: "src/foo.stele", line: 10, column: 5 };
    const error = new SteleError("E002", "parse", "bad syntax", span, "detail info", "try adding quotes");
    expect(error.span).toEqual(span);
    expect(error.detail).toBe("detail info");
    expect(error.hint).toBe("try adding quotes");
  });

  it("leaves optional fields undefined when not provided", () => {
    const error = new SteleError("E003", "parse", "bad syntax");
    expect(error.span).toBeUndefined();
    expect(error.detail).toBeUndefined();
    expect(error.hint).toBeUndefined();
  });

  it("allows partial optional arguments", () => {
    const error = new SteleError("E004", "parse", "bad syntax", undefined, "a detail");
    expect(error.span).toBeUndefined();
    expect(error.detail).toBe("a detail");
    expect(error.hint).toBeUndefined();
  });

  it("preserves all fields after construction", () => {
    const span = { file: "x.stele", line: 1, column: 1 };
    const error = new SteleError("E005", "lint", "message", span, "detail", "hint");
    expect(error.code).toBe("E005");
    expect(error.category).toBe("lint");
    expect(error.message).toBe("message");
    expect(error.span).toEqual(span);
    expect(error.detail).toBe("detail");
    expect(error.hint).toBe("hint");
  });
});
