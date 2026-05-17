import { describe, it, expect } from "vitest";
import { sanitizeArgs } from "../src/server.js";

describe("sanitizeArgs", () => {
  it("strips __proto__ key from args", () => {
    const result = sanitizeArgs({ name: "safe", __proto__: "malicious" });
    expect(Object.keys(result)).not.toContain("__proto__");
    expect((result as Record<string, unknown>).name).toBe("safe");
  });

  it("strips constructor key from args", () => {
    const result = sanitizeArgs({ name: "safe", constructor: "malicious" });
    expect(Object.keys(result)).not.toContain("constructor");
    expect((result as Record<string, unknown>).name).toBe("safe");
  });

  it("strips __defineGetter__ key from args", () => {
    const result = sanitizeArgs({ name: "safe", __defineGetter__: "malicious" });
    expect(Object.keys(result)).not.toContain("__defineGetter__");
    expect((result as Record<string, unknown>).name).toBe("safe");
  });

  it("strips __defineSetter__ key from args", () => {
    const result = sanitizeArgs({ name: "safe", __defineSetter__: "malicious" });
    expect(Object.keys(result)).not.toContain("__defineSetter__");
    expect((result as Record<string, unknown>).name).toBe("safe");
  });

  it("keeps safe keys intact", () => {
    const input = { foo: "bar", count: 42, nested: { a: 1, b: true } };
    const result = sanitizeArgs(input);
    expect(Object.keys(result)).not.toContain("__proto__");
    expect(Object.keys(result)).not.toContain("constructor");
    expect((result as Record<string, unknown>).foo).toBe("bar");
    expect((result as Record<string, unknown>).count).toBe(42);
  });

  it("handles nested objects with dangerous keys", () => {
    const result = sanitizeArgs({
      outer: {
        __proto__: "bad",
        __defineSetter__: "bad2",
        inner: { value: 42, constructor: "bad3" },
      },
    });

    const outer = (result as Record<string, unknown>).outer as Record<string, unknown>;
    expect(Object.keys(outer)).not.toContain("__proto__");
    expect(Object.keys(outer)).not.toContain("__defineSetter__");

    const inner = outer.inner as Record<string, unknown>;
    expect(Object.keys(inner)).not.toContain("constructor");
    expect(inner.value).toBe(42);
  });

  it("handles arrays with dangerous keys", () => {
    const result = sanitizeArgs({
      items: [
        { safe: true, __proto__: "bad" },
        { value: 2 },
        { __defineGetter__: "x" },
      ],
    });

    const items = (result as Record<string, unknown>).items as unknown[];
    expect((items[0] as Record<string, unknown>).safe).toBe(true);
    expect(Object.keys(items[0] as Record<string, unknown>)).not.toContain("__proto__");
    expect(((items[1] as Record<string, unknown>).value)).toBe(2);
    expect(Object.keys(items[2] as Record<string, unknown>)).not.toContain("__defineGetter__");
  });

  it("depth guard: returns empty object when depth exceeds MAX_SANITIZE_DEPTH", () => {
    // Build a chain of 15 nested objects to exceed the depth limit of 10.
    let deep: Record<string, unknown> = Object.create(null);
    for (let i = 15; i > 0; i--) {
      deep = { child: deep };
    }
    const result = sanitizeArgs(deep);

    // Walk down 11 levels to reach the guard-level empty object (depth 11 > MAX_SANITIZE_DEPTH).
    let cursor: Record<string, unknown> = result;
    for (let i = 0; i < 11; i++) {
      cursor = cursor.child as Record<string, unknown>;
    }
    expect(Object.keys(cursor).length).toBe(0);
    expect(Object.getPrototypeOf(cursor)).toBeNull();
  });

  it("returns a null-prototype object (no prototype pollution possible)", () => {
    const result = sanitizeArgs({ name: "test" });
    expect(Object.getPrototypeOf(result)).toBeNull();
    // Null-proto objects lack inherited Object.prototype methods.
    expect(result.hasOwnProperty).toBeUndefined();
  });

  it("handles null input args", () => {
    const result = sanitizeArgs(null as unknown as Record<string, unknown>);
    expect(Object.keys(result).length).toBe(0);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it("handles deeply nested arrays of objects", () => {
    const result = sanitizeArgs({
      matrix: [
        [{ value: 1, __proto__: "bad" }, { value: 2 }],
        [{ __defineSetter__: null, value: 3 }],
      ],
    });

    const matrix = (result as Record<string, unknown>).matrix as unknown[];
    const row0 = matrix[0] as unknown[];
    expect((row0[0] as Record<string, unknown>).value).toBe(1);
    expect(Object.keys(row0[0] as Record<string, unknown>)).not.toContain("__proto__");
    expect((row0[1] as Record<string, unknown>).value).toBe(2);

    const row1 = matrix[1] as unknown[];
    expect(Object.keys(row1[0] as Record<string, unknown>)).not.toContain("__defineSetter__");
    expect((row1[0] as Record<string, unknown>).value).toBe(3);
  });
});
