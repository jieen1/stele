import { describe, expect, it } from "vitest";
import { KNOWN_SAFE_COMMANDS } from "../src/util/known-safe-commands.js";

describe("known-safe-commands", () => {
  it("contains expected safe commands", () => {
    for (const cmd of ["cat", "echo", "grep", "ls", "pwd", "pytest", "diff", "cd", "date"]) {
      expect(KNOWN_SAFE_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it("rejects dangerous commands", () => {
    for (const cmd of ["rm", "mv", "cp", "curl", "wget", "vi", "vim", "nano", "gcc", "cargo", "pip"]) {
      expect(KNOWN_SAFE_COMMANDS.has(cmd)).toBe(false);
    }
  });

  it("rejects git (can overwrite protected files)", () => {
    expect(KNOWN_SAFE_COMMANDS.has("git")).toBe(false);
  });

  it("rejects shell interpreters", () => {
    for (const cmd of ["bash", "sh", "dash", "python", "python3", "node", "perl", "ruby"]) {
      expect(KNOWN_SAFE_COMMANDS.has(cmd)).toBe(false);
    }
  });

  it("rejects file-modifying tools", () => {
    for (const cmd of ["sed", "awk", "touch", "mkdir", "rmdir", "chmod", "chown"]) {
      expect(KNOWN_SAFE_COMMANDS.has(cmd)).toBe(false);
    }
  });

  it("set size is reasonable (15-40)", () => {
    const size = KNOWN_SAFE_COMMANDS.size;
    expect(size).toBeGreaterThanOrEqual(15);
    expect(size).toBeLessThanOrEqual(40);
  });

  it("all commands are simple identifiers (no spaces, no slashes)", () => {
    for (const cmd of KNOWN_SAFE_COMMANDS) {
      expect(cmd).not.toContain(" ");
      expect(cmd).not.toContain("/");
      expect(cmd).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
    }
  });
});
