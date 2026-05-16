import { describe, it, expect } from "vitest";
import { sanitizeError } from "../src/error-sanitizer.js";

describe("sanitizeError", () => {
  it("handles Error instances", () => {
    expect(sanitizeError(new Error("test message"))).toBe("test message");
  });

  it("handles string input", () => {
    expect(sanitizeError("plain string error")).toBe("plain string error");
  });

  it("handles non-string, non-Error input", () => {
    expect(sanitizeError(42)).toBe("42");
    expect(sanitizeError(null)).toBe("null");
    expect(sanitizeError(undefined)).toBe("undefined");
  });

  it("recursively sanitizes error.cause chains", () => {
    const cause = new Error("inner cause");
    const error = Object.assign(new Error("outer error"), { cause });
    const result = sanitizeError(error);
    expect(result).toContain("outer error");
    expect(result).toContain("cause: inner cause");
  });

  it("skips cause when same as message", () => {
    const same = new Error("same message");
    const error = Object.assign(new Error("same message"), { cause: same });
    const result = sanitizeError(error);
    expect(result).toBe("same message");
  });

  it("truncates messages exceeding 512 characters", () => {
    const long = "x".repeat(600);
    const result = sanitizeError(long);
    expect(result).toMatch(/\.\.\.\s*\(truncated\)$/);
  });

  it("does not truncate short messages", () => {
    expect(sanitizeError("short")).toBe("short");
  });

  // Stack trace redaction
  it("redacts stack trace function calls", () => {
    const msg = "Error at foo(bar) (./path/file.ts:10:5)";
    const result = sanitizeError(msg);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("foo(bar)");
  });

  it("redacts stack trace line:column format", () => {
    const msg = "at /some/path/file.ts:10:5";
    const result = sanitizeError(msg);
    expect(result).toContain("[redacted]");
  });

  // Path redaction
  it("redacts Unix paths", () => {
    const msg = "Failed to read /home/user/project/src/index.ts";
    const result = sanitizeError(msg);
    expect(result).toContain("[path]");
    expect(result).not.toContain("/home/user/project/src/index.ts");
  });

  it("redacts Windows paths", () => {
    const msg = "Failed to read C:\\Users\\user\\project\\src\\index.ts";
    const result = sanitizeError(msg);
    expect(result).toContain("[path]");
    expect(result).not.toContain("C:\\Users\\user\\project\\src\\index.ts");
  });

  // PID redaction
  it("redacts PIDs", () => {
    const msg = "Process pid 12345 exited";
    const result = sanitizeError(msg);
    expect(result).toContain("pid [redacted]");
    expect(result).not.toContain("12345");
  });

  // Environment variable redaction
  it("redacts API_KEY", () => {
    const msg = "API_KEY=sk-12345 failed";
    const result = sanitizeError(msg);
    expect(result).toContain("[redacted]");
  });

  it("redacts TOKEN", () => {
    const msg = "TOKEN=abc123 expired";
    const result = sanitizeError(msg);
    expect(result).toContain("[redacted]");
  });

  // Memory address redaction
  it("redacts memory addresses", () => {
    const msg = "Pointer 0xdeadbeef invalid";
    const result = sanitizeError(msg);
    expect(result).toContain("0x[redacted]");
  });

  // URL credential redaction
  it("redacts URLs with credentials", () => {
    const msg = "Connecting to https://user:pass@example.com/api";
    const result = sanitizeError(msg);
    expect(result).toContain("[credentials]@");
    expect(result).not.toContain("user:pass");
  });

  // Email redaction
  it("redacts email addresses", () => {
    const msg = "Contact user@example.com for help";
    const result = sanitizeError(msg);
    expect(result).toContain("[email]");
    expect(result).not.toContain("user@example.com");
  });

  it("handles multiple redactions in one message", () => {
    const msg = "pid 99999 failed at /home/user/file.ts with API_KEY=secret";
    const result = sanitizeError(msg);
    expect(result).toContain("pid [redacted]");
    expect(result).toContain("[path]");
    expect(result).toContain("[redacted]");
  });

  it("handles deeply nested cause chains", () => {
    const c3 = new Error("deepest");
    const c2 = Object.assign(new Error("middle"), { cause: c3 });
    const c1 = Object.assign(new Error("top"), { cause: c2 });
    const result = sanitizeError(c1);
    expect(result).toContain("top");
    expect(result).toContain("cause: middle");
    expect(result).toContain("cause: deepest");
  });
});
