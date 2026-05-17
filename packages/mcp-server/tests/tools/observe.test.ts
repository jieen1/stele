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

const { createObserveTool } = await import("../../src/tools/observe.js");

describe("stele-observe tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct tool metadata", async () => {
    const tool = createObserveTool();
    expect(tool.name).toBe("stele-observe");
    expect(tool.description).toContain("observation");
  });

  it("rejects invalid projectDir", async () => {
    const tool = createObserveTool();
    mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });
    const result = await tool.handler({ projectDir: "/nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path does not exist");
  });

  it("runs observe with --json by default", async () => {
    const tool = createObserveTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("{}", "utf8");
    await tool.handler({ projectDir: "/project" });
    expect(mockRunStele).toHaveBeenCalledWith("/project", ["observe", "--json"]);
  });

  it("includes --since when provided", async () => {
    const tool = createObserveTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockResolvedValue("{}", "utf8");
    await tool.handler({ projectDir: "/project", since: "2026-01-01" });
    expect(mockRunStele).toHaveBeenCalledWith("/project", ["observe", "--json", "--since", "2026-01-01"]);
  });

  it("propagates runStele errors", async () => {
    const tool = createObserveTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunStele.mockRejectedValueOnce(new Error("Command failed"));
    const result = await tool.handler({ projectDir: "/project" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unable to analyze observations");
  });
});
