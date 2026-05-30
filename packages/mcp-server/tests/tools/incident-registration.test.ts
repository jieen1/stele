import { describe, it, expect, vi } from "vitest";

// The incident tools import @stele/cli at module load; stub it so registration
// does not pull the real CLI runtime into this unit test.
vi.mock("@stele/cli", () => ({
  runIncidentDraft: vi.fn(),
  runIncidentTeeth: vi.fn(),
  runIncidentApprove: vi.fn(),
}));

const { registerTools } = await import("../../src/tools/index.js");
const { SteleMcpServer } = await import("../../src/server.js");

const INCIDENT_TOOLS = ["incident_draft", "incident_teeth", "incident_approve"];

describe("incident tool registration", () => {
  it("registerTools() includes the three incident tools with non-empty inputSchema", () => {
    const tools = registerTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of INCIDENT_TOOLS) {
      const tool = byName.get(name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(0);
      expect(Object.keys(tool!.inputSchema).length).toBeGreaterThan(0);
      expect(typeof tool!.handler).toBe("function");
    }
  });

  it("SteleMcpServer.getToolList() exposes all three incident tools", () => {
    const server = new SteleMcpServer();
    const names = server.getToolList().map((t) => t.name);
    for (const name of INCIDENT_TOOLS) {
      expect(names).toContain(name);
    }
  });
});
