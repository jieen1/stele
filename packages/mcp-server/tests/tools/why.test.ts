import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunStele = vi.fn(() => Promise.resolve(""));
vi.mock("../../src/stele-binary.js", () => ({ runStele: mockRunStele }));

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({ validateProjectDir: mockValidateProjectDir }));

const { createWhyTool } = await import("../../src/tools/why.js");

describe("stele-why tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct tool metadata", async () => {
    const tool = createWhyTool();
    expect(tool.name).toBe("stele-why");
    expect(tool.inputSchema.required).toContain("fingerprint");
  });

  it("rejects invalid projectDir", async () => {
    const tool = createWhyTool();
    mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });
    const result = await tool.handler({ fingerprint: "abc123" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path does not exist");
  });

  it("runs stele why with fingerprint", async () => {
    const tool = createWhyTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("Suppressed: baseline");
    await tool.handler({ projectDir: "/project", fingerprint: "abc123" });
    expect(mockRunStele).toHaveBeenCalledWith("/project", ["why", "abc123"]);
  });

  it("propagates errors with fingerprint context", async () => {
    const tool = createWhyTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockRejectedValueOnce(new Error("Not found"));
    const result = await tool.handler({ projectDir: "/project", fingerprint: "abc123" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("abc123");
  });
});
