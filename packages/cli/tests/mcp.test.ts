import { describe, test, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

describe("MCP server", () => {
  test("exports startMcpServer function", async () => {
    const { startMcpServer } = await import("../src/commands/mcp.js");
    expect(typeof startMcpServer).toBe("function");
  });

  test("MCP SDK is importable", () => {
    expect(Server).toBeDefined();
    expect(CallToolRequestSchema).toBeDefined();
    expect(ListToolsRequestSchema).toBeDefined();
  });
});
