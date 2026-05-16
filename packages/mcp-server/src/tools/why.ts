import { execFileSync } from "node:child_process";
import type { McpResult } from "../types.js";
import { validateProjectDir } from "../path-validation.js";

/**
 * MCP tool: stele-why
 *
 * Show why a violation was suppressed or why a specific
 * violation occurred. Uses `stele why <fingerprint>` from the CLI.
 */
export function createWhyTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-why",
    description:
      "Show why a violation was suppressed or why a specific violation occurred. Uses `stele why <fingerprint>`.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        fingerprint: {
          type: "string",
          description: "Violation fingerprint",
        },
      },
      required: ["fingerprint"],
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
      const fingerprint = args.fingerprint as string;

      try {
        const output = execFileSync("npx", ["stele", "why", fingerprint], {
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
              text: `Unable to explain violation ${fingerprint}: ${msg}\n\n` +
                `Run "stele why ${fingerprint}" directly to see the full explanation.`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
