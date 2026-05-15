import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { McpResult } from "../types.js";

const DEFAULT_PROJECT_DIR = process.cwd();

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
      const projectDir = resolve(args.projectDir as string ?? DEFAULT_PROJECT_DIR);
      const since = args.since as string | undefined;
      const cmdArgs = ["stele", "observe", "--json"];

      if (since) {
        cmdArgs.push("--since", since);
      }

      try {
        const output = execFileSync("npx", cmdArgs, {
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
              text: `Unable to analyze observations: ${msg}\n\n` +
                `Run "stele observe --json" directly to see the full report.`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
