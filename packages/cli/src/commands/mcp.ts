import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PROJECT_DIR = process.cwd();

/**
 * stele mcp — MCP server that exposes Stele contract checking capabilities.
 *
 * Tools:
 * - stele-check: Run `stele check` on a project directory
 * - stele-status: Check if project has Stele configured
 * - stele-observe: Run `stele observe` and return summary
 * - stele-list-contracts: List all contract files and status
 */
export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "stele-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "stele-check",
        description: "Run stele check on a project directory to verify contract compliance",
        inputSchema: {
          type: "object",
          properties: {
            projectDir: {
              type: "string",
              description: "Path to the project directory (defaults to current working directory)",
            },
          },
          required: [],
        },
      },
      {
        name: "stele-status",
        description: "Check if a project has Stele configured and list contracts",
        inputSchema: {
          type: "object",
          properties: {
            projectDir: {
              type: "string",
              description: "Path to the project directory",
            },
          },
          required: [],
        },
      },
      {
        name: "stele-observe",
        description: "Run stele observe to analyze agent observation data",
        inputSchema: {
          type: "object",
          properties: {
            projectDir: {
              type: "string",
              description: "Path to the project directory",
            },
          },
          required: [],
        },
      },
      {
        name: "stele-list-contracts",
        description: "List all Stele contract files and their status",
        inputSchema: {
          type: "object",
          properties: {
            projectDir: {
              type: "string",
              description: "Path to the project directory",
            },
          },
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const projectDir = (args.projectDir as string) ?? DEFAULT_PROJECT_DIR;

    switch (name) {
      case "stele-check":
        return runSteleCheck(projectDir);
      case "stele-status":
        return runSteleStatus(projectDir);
      case "stele-observe":
        return runSteleObserve(projectDir);
      case "stele-list-contracts":
        return runSteleListContracts(projectDir);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdout.write("[stele] MCP server started on stdio\n");
}

function runSteleCheck(projectDir: string) {
  try {
    const output = execSync("stele check", {
      cwd: projectDir,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return {
      content: [{ type: "text", text: output }],
      isError: false,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `stele check failed:\n${msg}` }],
      isError: true,
    };
  }
}

function runSteleStatus(projectDir: string) {
  const result: Record<string, unknown> = { projectDir };
  try {
    const configPath = join(projectDir, "stele.config.json");
    const contractDir = join(projectDir, "contract");
    result.hasConfig = existsSync(configPath);
    result.hasContractDir = existsSync(contractDir);

    if (result.hasConfig) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      result.config = config;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: false,
  };
}

function runSteleObserve(projectDir: string) {
  try {
    const output = execSync("stele observe --json", {
      cwd: projectDir,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return {
      content: [{ type: "text", text: output }],
      isError: false,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `stele observe failed:\n${msg}` }],
      isError: true,
    };
  }
}

function runSteleListContracts(projectDir: string) {
  const result: Record<string, unknown> = { projectDir, contracts: [] };
  try {
    const contractDir = join(projectDir, "contract");
    const entries = readdirSync(contractDir);
    if (!entries.length) return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false };

    const files = entries.filter(
      (f) => f.endsWith(".stele") || f.endsWith(".cdl")
    );
    result.contracts = files.map((f) => ({
      file: f,
      path: join(contractDir, f),
      size: statSync(join(contractDir, f)).size,
    }));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError: false,
  };
}
