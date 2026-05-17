import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpResult } from "../types.js";
import { listContractFiles, parseContractFromFile } from "../contract-cache.js";
import { validateProjectDir } from "../path-validation.js";

/**
 * MCP tool: stele-list-contracts
 *
 * List all Stele contract files and their parsed content.
 */
export function createListContractsTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<McpResult>;
} {
  return {
    name: "stele-list-contracts",
    description:
      "List all Stele contract files with their invariants, checkers, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        summary: {
          type: "boolean",
          description: "Return summary only (default: false)",
          default: false,
        },
      },
      required: [],
    },
    handler: async (args: Record<string, unknown>): Promise<McpResult> => {
      const validated = validateProjectDir(args.projectDir);
      if (validated.error) {
        return {
          content: [{ type: "text", text: validated.error }],
          isError: true,
        };
      }
      const projectDir = validated.path!;
      const summary = args.summary === true;
      const result = await buildContractsResult(projectDir, summary);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    },
  };
}

async function buildContractsResult(
  projectDir: string,
  summaryOnly: boolean
): Promise<Record<string, unknown>> {
  const contractDir = join(projectDir, "contract");
  const result: Record<string, unknown> = { projectDir, contracts: [] };

  if (!existsSync(contractDir)) {
    result.hasContractDir = false;
    return result;
  }

  result.hasContractDir = true;
  const files = listContractFiles(contractDir);
  result.fileCount = files.length;

  if (summaryOnly) {
    result.contracts = files.map((f) => ({
      file: f.path,
      size: f.size,
      modified: f.modified,
    }));
    return result;
  }

  // Parse contracts for detailed listing
  try {
    const parsedContracts: Array<Record<string, unknown>> = [];

    for (const file of files) {
      const parsed = await parseContractFromFile(file.path);
      parsedContracts.push({
        file: file.path,
        size: file.size,
        modified: file.modified,
        invariantCount: parsed.invariants.length,
        checkerCount: parsed.checkers.length,
        invariants: parsed.invariants,
        checkers: parsed.checkers,
      });
    }

    result.contracts = parsedContracts;
  } catch (err) {
    result.parseError = err instanceof Error ? err.message : String(err);
    result.contracts = files;
  }

  return result;
}
