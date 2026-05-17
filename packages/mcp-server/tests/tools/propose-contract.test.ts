import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunStele = vi.fn(() => Promise.resolve(""));
vi.mock("../../src/stele-binary.js", () => ({ runStele: mockRunStele }));

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({ validateProjectDir: mockValidateProjectDir }));

vi.mock("@stele/agent-hooks", () => ({ matchProtectedPath: vi.fn() }));
vi.mock("../../src/contract-cache.js", () => ({
  isSteleProject: vi.fn(), listContractFiles: vi.fn(),
  getProtectedPatterns: vi.fn(), getContractFiles: vi.fn(),
}));

const { createProposeContractTool } = await import("../../src/tools/propose-contract.js");

describe("stele-propose-contract tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct tool metadata", async () => {
    const tool = createProposeContractTool();
    expect(tool.name).toBe("stele-propose-contract");
    expect(tool.inputSchema.required).toContain("invariantId");
  });

  it("rejects invalid projectDir", async () => {
    const tool = createProposeContractTool();
    mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });
    const result = await tool.handler({ invariantId: "TEST", severity: "error", description: "Test", assert: "true" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path does not exist");
  });

  it("builds propose invariant command", async () => {
    const tool = createProposeContractTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("Preview generated successfully");
    await tool.handler({
      projectDir: "/project",
      invariantId: "TEST_INV",
      severity: "error",
      description: "Test invariant",
      assert: "(path user email matches \"^\\\\w+$\")",
    });
    expect(mockRunStele).toHaveBeenCalledWith("/project", [
      "propose", "invariant",
      "--id", "TEST_INV",
      "--severity", "error",
      "--description", "Test invariant",
      "--assert", "(path user email matches \"^\\\\w+$\")",
    ]);
  });

  it("includes --apply when requested", async () => {
    const tool = createProposeContractTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("Applied successfully");
    await tool.handler({
      projectDir: "/project",
      invariantId: "TEST_INV",
      severity: "error",
      description: "Test",
      assert: "true",
      apply: true,
    });
    expect(mockRunStele).toHaveBeenCalledWith("/project", expect.arrayContaining(["--apply"]));
  });

  it("includes category when provided", async () => {
    const tool = createProposeContractTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("OK");
    await tool.handler({
      projectDir: "/project",
      invariantId: "TEST",
      severity: "error",
      description: "Test",
      assert: "true",
      category: "security",
    });
    expect(mockRunStele).toHaveBeenCalledWith("/project", expect.arrayContaining(["--category", "security"]));
  });

  it("appends apply confirmation when apply=true", async () => {
    const tool = createProposeContractTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("Preview");
    const result = await tool.handler({
      projectDir: "/project",
      invariantId: "TEST_INV",
      severity: "error",
      description: "Test",
      assert: "true",
      apply: true,
    });
    expect(result.content[0].text).toContain("has been applied");
  });

  it("propagates runStele errors", async () => {
    const tool = createProposeContractTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockRejectedValueOnce(new Error("Command failed"));
    const result = await tool.handler({
      projectDir: "/project",
      invariantId: "TEST",
      severity: "error",
      description: "Test",
      assert: "true",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unable to propose invariant");
  });
});
