import type { McpResult } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { runStele } from "../stele-binary.js";
import { sanitizeError } from "../error-sanitizer.js";

/**
 * MCP tool: stele-propose-contract
 *
 * Propose a new contract invariant to be added to the project.
 * Uses `stele propose invariant --apply` from the CLI.
 *
 * This is an append-only operation — it never modifies existing rules.
 */
export function createProposeContractTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-propose-contract",
    description:
      "Propose a new contract invariant to be added to the project. Append-only — never modifies existing rules.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        invariantId: {
          type: "string",
          description: "Unique invariant ID (e.g., USER_EMAIL_MUST_BE_VALID)",
        },
        severity: {
          type: "string",
          enum: ["error", "warning", "info"],
          description: "Severity level",
        },
        description: {
          type: "string",
          description: "Human-readable description of the invariant",
        },
        assert: {
          type: "string",
          description: "CDL assertion expression",
        },
        category: {
          type: "string",
          description: "Optional category",
        },
        apply: {
          type: "boolean",
          description: "Apply the invariant immediately (default: false — preview only)",
          default: false,
        },
      },
      required: ["invariantId", "severity", "description", "assert"],
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
      const invariantId = String(args.invariantId ?? "");
      const severity = String(args.severity ?? "");
      const description = String(args.description ?? "");
      const assert = String(args.assert ?? "");
      const category = typeof args.category === "string" ? args.category : undefined;
      const apply = args.apply === true;

      const cmdArgs = [
        "propose",
        "invariant",
        "--id",
        invariantId,
        "--severity",
        severity,
        "--description",
        description,
        "--assert",
        assert,
        ...(category ? ["--category", category] : []),
        ...(apply ? ["--apply"] : []),
      ];

      try {
        const output = await runStele(projectDir, cmdArgs);

        return {
          content: [
            {
              type: "text",
              text: output +
                (apply
                  ? `\n\nInvariant ${invariantId} has been applied to the project.`
                  : `\n\nInvariant proposed. To apply, add --apply: true or run "stele propose invariant ${cmdArgs.join(" ")} --apply"`),
            },
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Unable to propose invariant ${invariantId}: ${sanitizeError(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
