import { describe, expect, it } from "vitest";
import {
  normalizeRelativeDirectoryPath,
  normalizeRelativeFilePath,
  assertPathWithinOutputDirectory,
  normalizeFileExtension,
  sanitizeGeneratedPathSegment,
} from "../src/generator/path-safety.js";

describe("normalizeRelativeDirectoryPath", () => {
  it("rejects root directory (.)", () => {
    expect(() => normalizeRelativeDirectoryPath(".", "path")).toThrow("Invalid");
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeRelativeDirectoryPath("/output", "path")).toThrow("Invalid path");
  });

  it("accepts valid directory paths", () => {
    expect(normalizeRelativeDirectoryPath("tests/contract", "path")).toBe("tests/contract");
  });
});

describe("normalizeRelativeFilePath", () => {
  it("rejects root directory (.)", () => {
    expect(() => normalizeRelativeFilePath(".", "path")).toThrow("Invalid");
  });

  it("accepts valid file paths", () => {
    expect(normalizeRelativeFilePath("tests/contract/test_main.py", "path")).toBe("tests/contract/test_main.py");
  });
});

describe("assertPathWithinOutputDirectory", () => {
  it("accepts valid nested paths", () => {
    expect(() => assertPathWithinOutputDirectory("tests/contract/test_main.py", "tests/contract")).not.toThrow();
    expect(() => assertPathWithinOutputDirectory("tests/contract/subdir/test_main.py", "tests/contract")).not.toThrow();
  });

  it("rejects paths outside output directory", () => {
    expect(() => assertPathWithinOutputDirectory("src/main.py", "tests/contract")).toThrow("is outside");
    expect(() => assertPathWithinOutputDirectory("../foo/bar.py", "tests/contract")).toThrow("is outside");
  });

  it("rejects absolute paths", () => {
    expect(() => assertPathWithinOutputDirectory("/tmp/test.py", "tests/contract")).toThrow("is outside");
  });
});

describe("normalizeFileExtension", () => {
  it("accepts valid extensions", () => {
    expect(normalizeFileExtension(".py")).toBe(".py");
    expect(normalizeFileExtension(".ts")).toBe(".ts");
    expect(normalizeFileExtension(".test.go")).toBe(".test.go");
    expect(normalizeFileExtension("_test.go")).toBe("_test.go");
  });

  it("rejects extensions without dot prefix", () => {
    expect(() => normalizeFileExtension("py")).toThrow("Invalid backend file extension");
  });

  it("rejects path separator extensions", () => {
    expect(() => normalizeFileExtension(".py/../foo")).toThrow("Invalid backend file extension");
  });

  it("rejects empty extension", () => {
    expect(() => normalizeFileExtension("")).toThrow("Invalid backend file extension");
  });
});

describe("sanitizeGeneratedPathSegment", () => {
  it("keeps alphanumeric segments", () => {
    expect(sanitizeGeneratedPathSegment("test_main", "fallback")).toBe("test_main");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeGeneratedPathSegment("test-main", "fallback")).toBe("test_main");
    expect(sanitizeGeneratedPathSegment("test@main", "fallback")).toBe("test_main");
  });

  it("uses fallback for empty segments", () => {
    expect(sanitizeGeneratedPathSegment("", "fallback")).toBe("fallback");
    expect(sanitizeGeneratedPathSegment("@#$%", "fallback")).toBe("fallback");
  });

  it("handles numeric-only segments", () => {
    expect(sanitizeGeneratedPathSegment("123", "num")).toBe("num_123");
  });

  it("handles segments starting with numbers", () => {
    expect(sanitizeGeneratedPathSegment("1test", "num")).toBe("num_1test");
  });
});
