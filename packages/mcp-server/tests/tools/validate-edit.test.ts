import { describe, it, expect, beforeEach, vi } from "vitest";

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

const mockMatchProtectedPath = vi.fn();
vi.mock("@stele/agent-hooks", () => ({
  matchProtectedPath: mockMatchProtectedPath,
}));

const mockGetProtectedPatterns = vi.fn();
vi.mock("../../src/contract-cache.js", () => ({
  getProtectedPatterns: mockGetProtectedPatterns,
  getContractFiles: vi.fn(),
  isSteleProject: vi.fn(),
  listContractFiles: vi.fn(),
}));

const { createValidateEditTool } = await import("../../src/tools/validate-edit.js");

describe("stele-validate-edit tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createValidateEditTool", () => {
    it("returns correct tool metadata", () => {
      const tool = createValidateEditTool();
      expect(tool.name).toBe("stele-validate-edit");
      expect(tool.description).toContain("edit");
      expect(tool.inputSchema.required).toContain("filePath");
    });
  });

  describe("handler", () => {
    it("rejects invalid projectDir", () => {
      const tool = createValidateEditTool();
      mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });

      const result = tool.handler({ filePath: "src/index.ts" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Path does not exist");
    });

    it("rejects missing filePath", () => {
      const tool = createValidateEditTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });

      const result = tool.handler({ projectDir: "/project" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Missing required argument: filePath");
    });

    it("rejects empty filePath", () => {
      const tool = createValidateEditTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });

      const result = tool.handler({ projectDir: "/project", filePath: "" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Missing required argument: filePath");
    });

    it("rejects non-string filePath", () => {
      const tool = createValidateEditTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });

      const result = tool.handler({ projectDir: "/project", filePath: 42 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Missing required argument: filePath");
    });

    it("allows edits to non-protected paths", () => {
      const tool = createValidateEditTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockGetProtectedPatterns.mockReturnValue(["contract/**/*.stele"]);
      mockMatchProtectedPath.mockReturnValue(false);

      const result = tool.handler({ projectDir: "/project", filePath: "src/index.ts" });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.allowed).toBe(true);
      expect(parsed.reason).toContain("not protected");
    });

    it("blocks edits to protected paths", () => {
      const tool = createValidateEditTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockGetProtectedPatterns.mockReturnValue(["contract/**/*.stele"]);
      mockMatchProtectedPath.mockReturnValue(true);

      const result = tool.handler({ projectDir: "/project", filePath: "contract/main.stele" });

      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.allowed).toBe(false);
      expect(parsed.reason).toContain("protected by Stele");
    });
  });
});
