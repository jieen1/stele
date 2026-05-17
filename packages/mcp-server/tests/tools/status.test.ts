import { describe, it, expect, beforeEach, vi } from "vitest";

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

vi.mock("@stele/agent-hooks", () => ({
  matchProtectedPath: vi.fn(),
}));

const mockIsSteleProject = vi.fn();
const mockListContractFiles = vi.fn();
vi.mock("../../src/contract-cache.js", () => ({
  isSteleProject: mockIsSteleProject,
  listContractFiles: mockListContractFiles,
  getProtectedPatterns: vi.fn(),
  getContractFiles: vi.fn(),
}));

const { createStatusTool } = await import("../../src/tools/status.js");

describe("stele-status tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createStatusTool", () => {
    it("returns correct tool metadata", () => {
      const tool = createStatusTool();
      expect(tool.name).toBe("stele-status");
      expect(tool.description).toContain("Stele");
      expect(tool.inputSchema.required.length).toBe(0);
    });
  });

  describe("handler", () => {
    it("rejects invalid projectDir", () => {
      const tool = createStatusTool();
      mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });

      const result = tool.handler({ projectDir: "/nonexistent" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Path does not exist");
    });

    it("returns JSON result for valid project", () => {
      const tool = createStatusTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockIsSteleProject.mockReturnValue(true);
      mockListContractFiles.mockReturnValue(["main.stele"]);

      const result = tool.handler({ projectDir: "/project" });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.projectDir).toBe("/project");
    });

    it("handles project without Stele config", () => {
      const tool = createStatusTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockIsSteleProject.mockReturnValue(false);
      mockListContractFiles.mockReturnValue([]);

      const result = tool.handler({ projectDir: "/project" });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.isSteleProject).toBe(false);
    });
  });
});
