import type { McpResult } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { runStele } from "../stele-binary.js";
import { sanitizeError } from "../error-sanitizer.js";

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
    handler: async (args: Record<string, unknown>): Promise<McpResult> => {
      const result = validateProjectDir(args.projectDir);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }
      const projectDir = result.path;
      const fingerprint = typeof args.fingerprint === "string" ? args.fingerprint : undefined;
      if (typeof fingerprint !== "string") {
        return {
          content: [{ type: "text", text: "Missing required parameter: fingerprint" }],
          isError: true,
        };
      }

      try {
        const output = await runStele(projectDir, ["why", fingerprint!]);

        return {
          content: [{ type: "text", text: output }],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Unable to explain violation ${fingerprint}: ${sanitizeError(error)}\n\n` +
                `Run "stele why ${fingerprint}" directly to see the full explanation.`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
