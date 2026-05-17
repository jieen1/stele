import type { McpResult } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { runStele } from "../stele-binary.js";
import { sanitizeError } from "../error-sanitizer.js";

/**
 * MCP tool: stele-observe
 *
 * Analyze agent observation data for invariant health trends.
 * Uses `stele observe` from the CLI.
 */
export function createObserveTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-observe",
    description:
      "Analyze agent observation data for invariant health trends. Uses `stele observe` from the CLI.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        since: {
          type: "string",
          description: "Filter observations since this ISO date (optional)",
        },
      },
      required: [],
    },
    handler: (args: Record<string, unknown>): McpResult => {
      const result = validateProjectDir(args.projectDir);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }
      const projectDir = result.path;
      const since = typeof args.since === "string" ? args.since : undefined;
      const cmdArgs = ["observe", "--json"];

      if (since) {
        // Validate ISO-date format as defense-in-depth
        if (isNaN(Date.parse(since))) {
          return {
            content: [{ type: "text", text: `Invalid since parameter: "${since}". Expected ISO-8601 date.` }],
            isError: true,
          };
        }
        cmdArgs.push("--since", since);
      }

      try {
        const output = runStele(projectDir, cmdArgs);

        return {
          content: [{ type: "text", text: output }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Unable to analyze observations: ${sanitizeError(error)}\n\n` +
                `Run "stele observe --json" directly to see the full report.`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
