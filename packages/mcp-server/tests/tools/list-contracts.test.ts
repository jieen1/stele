import { describe, it, expect, beforeEach, vi } from "vitest";

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

vi.mock("@stele/agent-hooks", () => ({ matchProtectedPath: vi.fn() }));

const mockParseContractFromFile = vi.fn();
const mockListContractFiles = vi.fn();
vi.mock("../../src/contract-cache.js", () => ({
  parseContractFromFile: mockParseContractFromFile,
  listContractFiles: mockListContractFiles,
  getProtectedPatterns: vi.fn(),
  getContractFiles: vi.fn(),
  isSteleProject: vi.fn(),
}));

const { createListContractsTool } = await import("../../src/tools/list-contracts.js");

describe("stele-list-contracts tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("$1", async () => {
    const tool = createListContractsTool();
    expect(tool.name).toBe("stele-list-contracts");
    expect(tool.inputSchema.required.length).toBe(0);
  });

  it("rejects invalid projectDir", async () => {
    const tool = createListContractsTool();
    mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });
    const result = await tool.handler({ projectDir: "/nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path does not exist");
  });

  it("returns empty contracts when no contract dir exists", async () => {
    const tool = createListContractsTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockListContractFiles.mockReturnValue([]);
    const result = await tool.handler({ projectDir: "/project" });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.contracts.length).toBe(0);
  });

  it("includes summary when requested", async () => {
    const tool = createListContractsTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockListContractFiles.mockReturnValue([{ path: "main.stele", size: 100, modified: "2026-01-01" }]);
    mockParseContractFromFile.mockResolvedValue({ invariants: [], checkers: [] });
    const result = await tool.handler({ projectDir: "/project", summary: true });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    // summary: true returns files without parsing
    expect(parsed.hasContractDir).toBeDefined();
  });
});
