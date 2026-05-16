import { execFileSync } from "node:child_process";
import type { McpResult } from "../types.js";
import { validateProjectDir } from "../path-validation.js";

/**
 * MCP tool: stele-explain-violation
 *
 * Explain why a specific violation occurred.
 * Uses `stele explain <id>` from the CLI.
 */
export function createExplainViolationTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-explain-violation",
    description:
      "Explain why a specific violation occurred. Shows invariant details, failure trace, and suggested fixes.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        violationId: {
          type: "string",
          description: "Invariant ID or violation fingerprint",
        },
      },
      required: ["violationId"],
    },
    handler: (args: Record<string, unknown>): McpResult => {
      const result = validateProjectDir(args.projectDir);
      if (result.error) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }
      const projectDir = result.path;
      const violationId = args.violationId as string;

      try {
        const output = execFileSync("npx", ["stele", "explain", violationId], {
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
          content: [
            {
              type: "text",
              text: `Unable to explain violation ${violationId}: ${msg}\n\n` +
                `Run "stele explain ${violationId}" directly to see the full explanation.`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
