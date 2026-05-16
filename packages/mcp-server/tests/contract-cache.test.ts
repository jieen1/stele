import { describe, it, expect } from "vitest";
import {
  scanSteleFiles,
  listContractFiles,
  loadContractFiles,
  isSteleProject,
  getCachedState,
  setCachedState,
  invalidateCache,
  getProtectedPatterns,
} from "../src/contract-cache.js";

describe("contract-cache", () => {;

  describe("scanSteleFiles", () => {
    it("returns empty array for non-existent directory", () => {
      const result = scanSteleFiles("/nonexistent/path/that/does/not/exist");
      expect(result).toEqual([]);
    });
  });

  describe("listContractFiles", () => {
    it("returns empty array for non-existent directory", () => {
      const result = listContractFiles("/nonexistent/path");
      expect(result).toEqual([]);
    });
  });

  describe("loadContractFiles", () => {
    it("returns empty array for non-existent directory", () => {
      const result = loadContractFiles("/nonexistent/path");
      expect(result).toEqual([]);
    });
  });

  describe("isSteleProject", () => {
    it("returns false for non-existent directory", () => {
      expect(isSteleProject("/nonexistent/path")).toBe(false);
    });
  });

  describe("getCachedState", () => {
    it("returns null for uncached project", () => {
      expect(getCachedState("/some/project")).toBeNull();
    });
  });

  describe("setCachedState / getCachedState", () => {
    it("stores and retrieves state", () => {
      const state = {
        projectDir: "/test/project",
        configPath: "/test/project/stele.config.json",
        contractFiles: [],
        lastLoadTime: Date.now(),
      };
      setCachedState(state);
      const retrieved = getCachedState("/test/project");
      expect(retrieved).toBe(state);
    });
  });

  describe("invalidateCache", () => {
    it("removes cached state", () => {
      const state = {
        projectDir: "/test/project2",
        configPath: "/test/project2/stele.config.json",
        contractFiles: [],
        lastLoadTime: Date.now(),
      };
      setCachedState(state);
      expect(getCachedState("/test/project2")).toBe(state);

      invalidateCache("/test/project2");
      expect(getCachedState("/test/project2")).toBeNull();
    });
  });

  describe("getProtectedPatterns", () => {
    it("returns default patterns for non-existent config", () => {
      const patterns = getProtectedPatterns("/nonexistent/path");
      expect(patterns).toContain("contract/**/*.stele");
    });
  });
});
