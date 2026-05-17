import { describe, it, expect, beforeEach, vi } from "vitest";

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

vi.mock("@stele/agent-hooks", () => ({
  matchProtectedPath: vi.fn(),
}));

const mockParseContract = vi.fn();
const mockListContractFiles = vi.fn();
const mockGetProtectedPatterns = vi.fn();
vi.mock("../../src/contract-cache.js", () => ({
  parseContract: mockParseContract,
  listContractFiles: mockListContractFiles,
  getProtectedPatterns: mockGetProtectedPatterns,
  getContractFiles: vi.fn(),
  isSteleProject: vi.fn(),
}));

const { createContextTool } = await import("../../src/tools/context.js");

describe("stele-context tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createContextTool", () => {
    it("returns correct tool metadata", () => {
      const tool = createContextTool();
      expect(tool.name).toBe("stele-context");
      expect(tool.description).toContain("agent");
      expect(tool.inputSchema.properties.format.enum).toContain("markdown");
    });
  });

  describe("handler", () => {
    it("rejects invalid projectDir", async () => {
      const tool = createContextTool();
      mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });

      const result = await tool.handler({ projectDir: "/nonexistent" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Path does not exist");
    });

    it("returns markdown format by default", async () => {
      const tool = createContextTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockListContractFiles.mockReturnValue([]);
      mockParseContract.mockReturnValue({ invariants: [], checkers: [] });

      const result = await tool.handler({ projectDir: "/project" });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("# Stele Contract Context");
    });

    it("returns json format when requested", async () => {
      const tool = createContextTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockListContractFiles.mockReturnValue([]);
      mockParseContract.mockReturnValue({ invariants: [], checkers: [] });

      const result = await tool.handler({ projectDir: "/project", format: "json" });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.projectDir).toBe("/project");
    });

    it("validates focusPaths stay within projectDir", async () => {
      const tool = createContextTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockListContractFiles.mockReturnValue([]);
      mockParseContract.mockReturnValue({ invariants: [], checkers: [] });

      const result = await tool.handler({
        projectDir: "/project",
        focusPaths: ["../../etc/passwd"],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("escapes project directory");
    });
  });
});
