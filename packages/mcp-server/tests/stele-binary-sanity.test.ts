import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecFileCallback } from "node:child_process";

// Mock child_process before importing stele-binary
vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, execFile: vi.fn() };
});

// Get the mocked execFile spy (shared with stele-binary.js)
import { execFile as execFileMock } from "node:child_process";

import { runStele, clearBinaryCache } from "../src/stele-binary.js";

beforeEach(() => {
  clearBinaryCache();
  execFileMock.mockReset();
});

describe("runStele stdout sanitization", () => {
  it("resolves sanitized stdout on success", async () => {
    setupExecFile("clean output");
    const result = await runStele(process.cwd(), ["version"]);
    expect(result).toBe("clean output");
  });

  it("redacts Bearer tokens from stdout", async () => {
    setupExecFile("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature123");
    const result = await runStele(process.cwd(), ["check"]);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result).not.toContain("signature123");
  });

  it("redacts generic secret prefixes from stdout", async () => {
    setupExecFile("Key: sk-1234567890abcdef");
    const result = await runStele(process.cwd(), ["check"]);
    expect(result).not.toContain("sk-1234567890abcdef");
  });

  it("redacts SSH private key headers from stdout", async () => {
    setupExecFile("Key: -----BEGIN OPENSSH PRIVATE KEY-----\ndata\n-----END OPENSSH PRIVATE KEY-----");
    const result = await runStele(process.cwd(), ["check"]);
    expect(result).toContain("[private-key]");
    expect(result).not.toContain("BEGIN OPENSSH");
  });

  it("redacts JWT-like tokens from stdout", async () => {
    setupExecFile(
      "Auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4"
    );
    const result = await runStele(process.cwd(), ["check"]);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("[jwt]");
  });

  it("redacts multiple credential types in a single stdout", async () => {
    setupExecFile(
      "Bearer abc123 and sk-abcdefghijklmnop and eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4"
    );
    const result = await runStele(process.cwd(), ["check"]);
    expect(result).not.toContain("Bearer abc123");
    expect(result).not.toContain("sk-abcdefghijklmnop");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result).toContain("[authorization]");
    expect(result).toContain("[secret]");
    expect(result).toContain("[jwt]");
  });

  it("rejects with stderr on CLI error", async () => {
    setupExecFile("success", "simulated error");
    await expect(runStele(process.cwd(), ["check"])).rejects.toThrow("simulated error");
  });

  it("passes through clean output unchanged", async () => {
    setupExecFile("Stele check: 0 violations found");
    const result = await runStele(process.cwd(), ["check"]);
    expect(result).toBe("Stele check: 0 violations found");
  });
});

/**
 * Replace execFile with a mock that returns the given stdout or rejects with stderr.
 * Uses setImmediate to match the real child_process async behavior.
 */
function setupExecFile(stdout: string, stderr?: string) {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: object, cb: ExecFileCallback) => {
    setImmediate(() => {
      if (stderr) {
        cb(new Error(stderr), stdout, stderr);
      } else {
        cb(null, stdout, "");
      }
    });
  });
}
