import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { validateProjectDir } from "../src/path-validation.js";

describe("path traversal protection", () => {
  it("rejects parent directory traversal via relative path", () => {
    const result = validateProjectDir("../../../etc/passwd");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects deep nested traversal", () => {
    const result = validateProjectDir("a/b/c/d/../../../etc/passwd");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects UNC path on Windows", () => {
    const uncPath = "\\\\server\\share";
    const result = validateProjectDir(uncPath);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("UNC");
    }
  });

  it("rejects Windows namespace path", () => {
    const nsPath = "\\\\?\\C:\\windows\\system32";
    const result = validateProjectDir(nsPath);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects \\admin$ path", () => {
    const adminPath = "\\\\.\\admin$";
    const result = validateProjectDir(adminPath);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects \\device\\ paths", () => {
    const devicePath = "\\\\?\\device";
    const result = validateProjectDir(devicePath);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects //./ paths", () => {
    const path = "//./path";
    const result = validateProjectDir(path);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects //host/share paths", () => {
    const path = "//host/share";
    const result = validateProjectDir(path);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects \\server\\share paths", () => {
    const path = "\\server\\share";
    const result = validateProjectDir(path);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects \\?\\UNC\\ paths", () => {
    const path = "\\\\?\\UNC\\server\\share";
    const result = validateProjectDir(path);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("UNC");
    }
  });

  it("rejects \\?\\ paths", () => {
    const path = "\\\\?\\C:\\path";
    const result = validateProjectDir(path);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("accepts resolved valid path", () => {
    const result = validateProjectDir(process.cwd());
    expect("error" in result).toBe(false);
    if ("path" in result) {
      expect(result.path).toBe(resolve(process.cwd()));
    }
  });

  it("rejects file paths", () => {
    const result = validateProjectDir(__filename);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not a directory");
    }
  });

  it("rejects non-existent paths", () => {
    const result = validateProjectDir("/nonexistent-project-xyz");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects undefined input", () => {
    const result = validateProjectDir(undefined);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects empty string", () => {
    const result = validateProjectDir("");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBeTruthy();
    }
  });
});