import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { McpResult } from "../types.js";

const DEFAULT_PROJECT_DIR = process.cwd();

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
    handler: (args: Record<string, unknown>): McpResult => {
      const projectDir = resolve(args.projectDir as string ?? DEFAULT_PROJECT_DIR);
      const invariantId = args.invariantId as string;
      const severity = args.severity as string;
      const description = args.description as string;
      const assert = args.assert as string;
      const category = args.category as string | undefined;
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
        const output = execFileSync("npx", ["stele", ...cmdArgs], {
          cwd: projectDir,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });

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
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Unable to propose invariant ${invariantId}: ${msg}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
