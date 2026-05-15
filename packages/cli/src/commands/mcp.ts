import { SteleMcpServer } from "@stele/mcp-server";

/**
 * stele mcp — Bridge to the @stele/mcp-server package.
 *
 * The MCP server logic now lives in @stele/mcp-server for platform
 * independence. This command is a thin bridge that starts the MCP
 * server via dynamic import.
 */
export async function startMcpServer(): Promise<void> {
  const server = new SteleMcpServer();
  await server.start();
}
