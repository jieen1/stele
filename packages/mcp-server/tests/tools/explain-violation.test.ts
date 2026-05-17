import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunStele = vi.fn(() => Promise.resolve(""));
vi.mock("../../src/stele-binary.js", () => ({
  runStele: mockRunStele,
}));

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

const { createExplainViolationTool } = await import("../../src/tools/explain-violation.js");

describe("stele-explain-violation tool", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns correct tool metadata", async () => {
    const tool = createExplainViolationTool();
    expect(tool.name).toBe("stele-explain-violation");
    expect(tool.inputSchema.required).toContain("violationId");
  });

  it("rejects invalid projectDir", async () => {
    const tool = createExplainViolationTool();
    mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });
    const result = await tool.handler({ violationId: "INV_001" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path does not exist");
  });

  it("runs stele explain with violation ID", async () => {
    const tool = createExplainViolationTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("Explanation for INV_001");
    const result = await tool.handler({ projectDir: "/project", violationId: "INV_001" });
    expect(mockRunStele).toHaveBeenCalledWith("/project", ["explain", "INV_001"]);
    expect(result.isError).toBe(false);
  });

  it("propagates errors with violationId context", async () => {
    const tool = createExplainViolationTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockRejectedValueOnce(new Error("Not found"));
    const result = await tool.handler({ projectDir: "/project", violationId: "INV_001" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INV_001");
  });
});
