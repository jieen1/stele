import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpResult } from "../types.js";
import { isSteleProject, listContractFiles } from "../contract-cache.js";

const DEFAULT_PROJECT_DIR = process.cwd();

/**
 * MCP tool: stele-status
 *
 * Check if a project has Stele configured and list contracts.
 */
export function createStatusTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-status",
    description:
      "Check if a project has Stele configured and list contract files with metadata.",
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
    handler: (args: Record<string, unknown>): McpResult => {
      const projectDir = resolve(args.projectDir as string ?? DEFAULT_PROJECT_DIR);
      const result = buildStatusResult(projectDir);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    },
  };
}

function buildStatusResult(projectDir: string): Record<string, unknown> {
  const result: Record<string, unknown> = { projectDir };

  try {
    const configPath = join(projectDir, "stele.config.json");
    const contractDir = join(projectDir, "contract");

    result.hasConfig = existsSync(configPath);
    result.hasContractDir = existsSync(contractDir);
    result.isSteleProject = isSteleProject(projectDir);

    if (result.hasConfig) {
      try {
        const raw = require("node:fs").readFileSync(configPath, "utf8");
        result.config = JSON.parse(raw);
      } catch (err) {
        result.configError = err instanceof Error ? err.message : String(err);
      }
    }

    if (result.hasContractDir) {
      const files = listContractFiles(contractDir);
      result.contracts = files;
      result.contractCount = files.length;
    }

    // Check for manifest
    const manifestPath = join(contractDir, ".manifest.json");
    result.hasManifest = existsSync(manifestPath);

    // Check for baseline
    const baselinePath = join(contractDir, ".baseline.json");
    result.hasBaseline = existsSync(baselinePath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}
