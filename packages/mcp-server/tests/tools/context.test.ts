import { resolve } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

vi.mock("@stele/agent-hooks", () => ({
  matchProtectedPath: vi.fn(),
}));

const mockParseContractFromFile = vi.fn();
const mockListContractFiles = vi.fn();
const mockGetProtectedPatterns = vi.fn();
vi.mock("../../src/contract-cache.js", () => ({
  parseContractFromFile: mockParseContractFromFile,
  listContractFiles: mockListContractFiles,
  getProtectedPatterns: mockGetProtectedPatterns,
  getContractFiles: vi.fn(),
  isSteleProject: vi.fn(),
}));

const { createContextTool } = await import("../../src/tools/context.js");

// Use a real Windows path so resolve/relative behave correctly in tests
const testProjectDir = resolve(__dirname, "..", "..", "test-project", "src");

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
      mockValidateProjectDir.mockReturnValue({ path: testProjectDir });
      mockListContractFiles.mockReturnValue([]);
      mockParseContractFromFile.mockResolvedValue({ invariants: [], checkers: [] });

      const result = await tool.handler({ projectDir: testProjectDir });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain("# Stele Contract Context");
    });

    it("returns json format when requested", async () => {
      const tool = createContextTool();
      mockValidateProjectDir.mockReturnValue({ path: testProjectDir });
      mockListContractFiles.mockReturnValue([]);
      mockParseContractFromFile.mockResolvedValue({ invariants: [], checkers: [] });

      const result = await tool.handler({ projectDir: testProjectDir, format: "json" });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.projectDir).toBe(testProjectDir);
    });

    it("validates focusPaths stay within projectDir", async () => {
      const tool = createContextTool();
      mockValidateProjectDir.mockReturnValue({ path: testProjectDir });
      mockListContractFiles.mockReturnValue([]);
      mockParseContractFromFile.mockResolvedValue({ invariants: [], checkers: [] });

      const result = await tool.handler({
        projectDir: testProjectDir,
        focusPaths: ["../../etc/passwd"],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("escapes project directory");
    });
  });
});
