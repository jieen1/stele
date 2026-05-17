import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunStele = vi.fn();
vi.mock("../../src/stele-binary.js", () => ({
  runStele: mockRunStele,
}));

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({
  validateProjectDir: mockValidateProjectDir,
}));

const { createCheckTool } = await import("../../src/tools/check.js");

describe("stele-check tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createCheckTool", () => {
    it("returns correct tool metadata", () => {
      const tool = createCheckTool();
      expect(tool.name).toBe("stele-check");
      expect(tool.description).toContain("stele check");
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties.projectDir.type).toBe("string");
    });
  });

  describe("handler", () => {
    it("rejects invalid projectDir", () => {
      const tool = createCheckTool();
      mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });

      const result = tool.handler({ projectDir: "/nonexistent" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Path does not exist");
    });

    it("runs stele check with JSON output by default", () => {
      const tool = createCheckTool();
      mockValidateProjectDir.mockReturnValue({ path: "/valid-project" });
      mockRunStele.mockReturnValue(JSON.stringify({ ok: true, report: {}, summary: {} }));

      tool.handler({ projectDir: "/valid-project" });

      expect(mockRunStele).toHaveBeenCalledWith("/valid-project", ["check", "--json"]);
    });

    it("respects json: false flag", () => {
      const tool = createCheckTool();
      mockValidateProjectDir.mockReturnValue({ path: "/valid-project" });
      mockRunStele.mockReturnValue(JSON.stringify({ ok: true, report: {}, summary: {} }));

      tool.handler({ projectDir: "/valid-project", json: false });

      expect(mockRunStele).toHaveBeenCalledWith("/valid-project", ["check"]);
    });

    it("uses undefined projectDir when not provided", () => {
      const tool = createCheckTool();
      mockValidateProjectDir.mockReturnValue({ path: process.cwd() });
      mockRunStele.mockReturnValue(JSON.stringify({ ok: true, report: {}, summary: {} }));

      tool.handler({});

      expect(mockValidateProjectDir).toHaveBeenCalledWith(undefined);
    });

    it("propagates runStele errors as MCP error", () => {
      const tool = createCheckTool();
      mockValidateProjectDir.mockReturnValue({ path: "/valid-project" });
      mockRunStele.mockImplementation(() => { throw new Error("Command failed"); });

      const result = tool.handler({ projectDir: "/valid-project" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Command failed");
    });

    it("returns violation details when violations exist", () => {
      const tool = createCheckTool();
      mockValidateProjectDir.mockReturnValue({ path: "/valid-project" });
      mockRunStele.mockReturnValue(
        JSON.stringify({
          ok: false,
          violations: [
            { rule_id: "INV_001", cause: { summary: "User email invalid" } },
            { rule_id: "INV_002", cause: { summary: "Password too weak" } },
          ],
          summary: { invariant_count: 5, generated_file_count: 3, protected_file_count: 2, violation_count: 2 },
        })
      );

      const result = tool.handler({ projectDir: "/valid-project", json: false });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("INV_001");
      expect(result.content[0].text).toContain("User email invalid");
    });
  });
});
