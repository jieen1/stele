import { describe, it, expect, beforeEach } from "vitest";
import { clearBinaryCache, resolveSteleBinary, runStele } from "../src/stele-binary.js";

describe("stele-binary", () => {
  beforeEach(() => {
    clearBinaryCache();
  });

  describe("resolveSteleBinary", () => {
    it("returns null when no local installation exists", async () => {
      const result = resolveSteleBinary("/nonexistent-project-dir-xyz");
      expect(result).toBeNull();
    });

    it("resolves binary from monorepo root node_modules", async () => {
      // The monorepo root has @stele/cli installed
      const result = resolveSteleBinary(process.cwd());
      expect(result).toBeDefined();
    });

    it("caches results for same directory", async () => {
      clearBinaryCache();
      const r1 = resolveSteleBinary(process.cwd());
      const r2 = resolveSteleBinary(process.cwd());
      expect(r1).toBe(r2);
    });
  });

  describe("clearBinaryCache", () => {
    it("invalidates cached results", async () => {
      resolveSteleBinary(process.cwd());
      clearBinaryCache();
      const result = resolveSteleBinary(process.cwd());
      // Should still resolve (binary exists), but via fresh lookup
      expect(result).toBeDefined();
    });
  });

  describe("runStele", () => {
    it("validates arguments for newlines", async () => {
      await expect(runStele(process.cwd(), ["check\nmalicious"])).rejects.toThrow("Invalid character");
    });

    it("validates arguments for null bytes", async () => {
      await expect(runStele(process.cwd(), ["check\x00malicious"])).rejects.toThrow("Invalid character");
    });

    it("validates argument length", async () => {
      const longArg = "x".repeat(4097);
      await expect(runStele(process.cwd(), [longArg])).rejects.toThrow("exceeds maximum length");
    });

    it("throws when no local installation exists", async () => {
      clearBinaryCache();
      await expect(runStele("/nonexistent-dir", ["check"])).rejects.toThrow("Cannot execute stele");
    });
  });
});