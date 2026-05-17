import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunStele = vi.fn(() => Promise.resolve(""));
vi.mock("../../src/stele-binary.js", () => ({
  runStele: mockRunStele,
}));

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

const mockReadMaterialObservations = vi.fn();
vi.mock("../../src/session-state.js", () => ({
  getSessionState: vi.fn(() => ({ recordCheck: vi.fn() })),
  readMaterialObservations: mockReadMaterialObservations,
}));

const mockLoadProjectState = vi.fn();
vi.mock("../../src/contract-cache.js", () => ({
  loadProjectState: mockLoadProjectState,
  isSteleProject: vi.fn(),
  listContractFiles: vi.fn(),
  getProtectedPatterns: vi.fn(),
  getContractFiles: vi.fn(),
}));

const { createCheckSessionTool } = await import("../../src/tools/check-session.js");

describe("stele-check-session tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createCheckSessionTool", () => {
    it("returns correct tool metadata", async () => {
      const tool = createCheckSessionTool();
      expect(tool.name).toBe("stele-check-session");
      expect(tool.description).toContain("session");
    });
  });

  describe("handler", () => {
    it("rejects invalid projectDir", async () => {
      const tool = createCheckSessionTool();
      mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });

      const result = await tool.handler({ projectDir: "/nonexistent" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Path does not exist");
    });

    it("runs check and returns JSON by default", async () => {
      const tool = createCheckSessionTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockReadMaterialObservations.mockReturnValue([]);
      mockRunStele.mockResolvedValue(JSON.stringify({ ok: true, violations: [], summary: {} }));

      const result = await tool.handler({ projectDir: "/project" });

      expect(result.isError).toBe(false);
      expect(mockRunStele).toHaveBeenCalledWith("/project", ["check", "--json"]);
      expect(result.content[0].text).toContain("check");
    });

    it("includes maintenance review when observations exist", async () => {
      const tool = createCheckSessionTool();
      mockValidateProjectDir.mockReturnValue({ path: "/project" });
      mockReadMaterialObservations.mockReturnValue([{ path: "src/changed.ts" }]);
      mockRunStele.mockResolvedValue(JSON.stringify({ ok: true, violations: [], summary: {} }));

      const result = await tool.handler({ projectDir: "/project" });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.maintenanceReview.required).toBe(true);
    });
  });
});
