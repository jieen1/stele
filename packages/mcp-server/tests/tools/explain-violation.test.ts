import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunStele = vi.fn();
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

  it("returns correct tool metadata", () => {
    const tool = createExplainViolationTool();
    expect(tool.name).toBe("stele-explain-violation");
    expect(tool.inputSchema.required).toContain("violationId");
  });

  it("rejects invalid projectDir", () => {
    const tool = createExplainViolationTool();
    mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });
    const result = tool.handler({ violationId: "INV_001" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path does not exist");
  });

  it("runs stele explain with violation ID", () => {
    const tool = createExplainViolationTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockReturnValue("Explanation for INV_001");
    const result = tool.handler({ projectDir: "/project", violationId: "INV_001" });
    expect(mockRunStele).toHaveBeenCalledWith("/project", ["explain", "INV_001"]);
    expect(result.isError).toBe(false);
  });

  it("propagates errors with violationId context", () => {
    const tool = createExplainViolationTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockImplementation(() => { throw new Error("Not found"); });
    const result = tool.handler({ projectDir: "/project", violationId: "INV_001" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INV_001");
  });
});
