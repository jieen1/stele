import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpResult } from "../types.js";
import { isSteleProject, listContractFiles } from "../contract-cache.js";
import { validateProjectDir } from "../path-validation.js";

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
      const validated = validateProjectDir(args.projectDir);
      if ("error" in validated) {
        return {
          content: [{ type: "text", text: validated.error }],
          isError: true,
        };
      }
      const projectDir = validated.path;
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
        const raw = readFileSync(configPath, "utf8");
        const config = JSON.parse(raw);
        // Only expose the fields needed for status — not the full config
        result.configTargetLanguage = typeof config?.targetLanguage === "string" ? config.targetLanguage : undefined;
        result.configProtectedCount = Array.isArray(config?.protected) ? config.protected.length : 0;
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
