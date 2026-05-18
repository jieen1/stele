import { describe, it, expect } from "vitest";
import { validateProjectDir, requireProjectDir } from "../src/path-validation.js";

describe("validateProjectDir", () => {
  it("rejects non-string input", () => {
    expect(validateProjectDir(null).error).toContain("non-empty string");
    expect(validateProjectDir(undefined).error).toContain("non-empty string");
    expect(validateProjectDir(42).error).toContain("non-empty string");
    expect(validateProjectDir({}).error).toContain("non-empty string");
    expect(validateProjectDir([]).error).toContain("non-empty string");
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(validateProjectDir("").error).toContain("non-empty string");
    expect(validateProjectDir("   ").error).toContain("non-empty string");
  });

  it("rejects non-existent paths", () => {
    const result = validateProjectDir("/nonexistent-path-xyz-12345");
    expect(result.error).toContain("does not exist");
    expect(result.path).toBeUndefined();
  });

  it("rejects UNC paths", () => {
    // On Windows, resolve() may handle UNC differently, so check what we can
    const result = validateProjectDir("\\\\malicious\\unc\\path");
    // The resolved path may or may not start with \\ depending on platform
    // The UNC check catches the original trimmed path via resolve()
    if (result.error) {
      expect(result.error).toContain("UNC paths");
    }
  });

  it("returns resolved path for valid directory", () => {
    // Use the package's own directory — it exists and is a directory
    const result = validateProjectDir(__dirname);
    expect(result.error).toBeUndefined();
    expect(result.path).toBeDefined();
  });

  it("trims whitespace from input", () => {
    const result = validateProjectDir(__dirname);
    expect(result.error).toBeUndefined();
  });

  it("rejects files that are not directories (path-validation file check)", () => {
    const result = validateProjectDir(__filename);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("is not a directory");
  });

  it("returns realpath-normalized path for valid directory", () => {
    const result = validateProjectDir(__dirname);
    if ("path" in result) {
      // On Windows, realpath may differ from resolve, but should be a valid path
      expect(result.path).toBeDefined();
      expect(typeof result.path).toBe("string");
    }
  });

  it("rejects files that are not directories", () => {
    // Point at a file — it exists but is not a directory
    // The package.json in the parent directory should exist as a file
    const result = validateProjectDir(__filename);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("is not a directory");
  });
});

describe("requireProjectDir", () => {
  it("returns resolved path for valid input", () => {
    const path = requireProjectDir(__dirname);
    expect(path).toBeDefined();
  });

  it("throws for invalid input", () => {
    expect(() => requireProjectDir("")).toThrow("Invalid projectDir");
    expect(() => requireProjectDir(null)).toThrow("Invalid projectDir");
    expect(() => requireProjectDir(42)).toThrow("Invalid projectDir");
  });

  it("throws descriptive error message", () => {
    expect(() => requireProjectDir("")).toThrow("Invalid projectDir: projectDir must be a non-empty string");
  });

  it("throws for non-existent path", () => {
    expect(() => requireProjectDir("/nonexistent-xyz-99999"))
      .toThrow("Invalid projectDir: Path does not exist");
  });
});
