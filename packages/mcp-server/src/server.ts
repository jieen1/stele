import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools/index.js";
import { sanitizeError } from "./error-sanitizer.js";
import type { ToolDef } from "./types.js";

/**
 * Sanitize MCP tool arguments against prototype pollution.
 * Copies only own enumerable properties onto a null-proto object.
 */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const DANGEROUS = new Set(["__proto__", "constructor", "__defineGetter__", "__defineSetter__"]);
  const safe = Object.create(null);
  for (const key of Object.keys(args ?? {})) {
    if (!DANGEROUS.has(key)) {
      const value = args[key];
      safe[key] = typeof value === "object" && value !== null && !Array.isArray(value)
        ? sanitizeArgs(value as Record<string, unknown>)
        : value;
    }
  }
  return safe;
}

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
      const { name, arguments: rawArgs = {} } = request.params;
      const args = sanitizeArgs(rawArgs);
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
              text: `[stele-mcp] Tool "${name}" threw unhandled error: ${sanitizeError(error)}`,
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
