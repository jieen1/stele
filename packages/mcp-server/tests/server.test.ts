import { describe, it, expect } from "vitest";
import { SteleMcpServer } from "../src/index.js";

describe("SteleMcpServer", () => {
  it("instantiates without error", () => {
    const server = new SteleMcpServer();
    expect(server).toBeDefined();
  });

  it("registers all 13 tools", () => {
    const server = new SteleMcpServer();
    const tools = server.getToolList();
    expect(tools.length).toBe(13);
  });

  it("has expected tool names", () => {
    const server = new SteleMcpServer();
    const tools = server.getToolList();
    const names = tools.map((t) => t.name);

    expect(names).toContain("stele-check");
    expect(names).toContain("stele-status");
    expect(names).toContain("stele-list-contracts");
    expect(names).toContain("stele-context");
    expect(names).toContain("stele-validate-edit");
    expect(names).toContain("stele-check-session");
    expect(names).toContain("stele-explain-violation");
    expect(names).toContain("stele-why");
    expect(names).toContain("stele-propose-contract");
    expect(names).toContain("stele-observe");
    expect(names).toContain("incident_draft");
    expect(names).toContain("incident_teeth");
    expect(names).toContain("incident_approve");
  });

  it("each tool has name, description, inputSchema, and handler", () => {
    const server = new SteleMcpServer();
    const tools = server.getToolList();

    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe("function");
    }
  });
});
