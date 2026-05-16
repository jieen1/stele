import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools/index.js";
import type { ToolDef } from "./types.js";

/**
 * Stele MCP Server
 *
 * Contract-aware MCP server for AI agent integration.
 * Provides tools for contract validation, violation explanation,
 * session management, and more.
 */
export class SteleMcpServer {
  private server: Server;
  private tools: ToolDef[] = [];
  private toolMap: Map<string, ToolDef> = new Map();

  constructor() {
    this.server = new Server(
      { name: "stele-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    this.setupHandlers();
  }

  /**
   * Register all tools with the server.
   */
  private setupHandlers(): void {
    this.tools = registerTools();
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));

    this.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      const tool = this.toolMap.get(name);

      if (!tool) {
        return {
          content: [
            {
              type: "text",
              text: `[stele-mcp] Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await tool.handler(args);

        return {
          content: result.content,
          isError: result.isError,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `[stele-mcp] Tool "${name}" threw unhandled error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Start the server on stdio.
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stdout.write("[stele] MCP server started on stdio\n");
  }

  /**
   * Get the list of registered tools.
   */
  getToolList(): ToolDef[] {
    return this.tools;
  }
}
