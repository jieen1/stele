import type { McpResult } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { runStele } from "../stele-binary.js";
import { sanitizeError } from "../error-sanitizer.js";

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
    handler: async (args: Record<string, unknown>): Promise<McpResult> => {
      const result = validateProjectDir(args.projectDir);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }
      const projectDir = result.path;
      const violationId = typeof args.violationId === "string" ? args.violationId : undefined;
      if (typeof violationId !== "string") {
        return {
          content: [{ type: "text", text: "Missing required parameter: violationId" }],
          isError: true,
        };
      }

      try {
        const output = await runStele(projectDir, ["explain", violationId!]);

        return {
          content: [{ type: "text", text: output }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Unable to explain violation ${violationId}: ${sanitizeError(error)}\n\n` +
                `Run "stele explain ${violationId}" directly to see the full explanation.`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
