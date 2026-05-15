import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { McpResult, ValidateEditResult } from "../types.js";
import { getSessionState, isProtectedPath } from "../session-state.js";
import { getProtectedPatterns, loadProjectState } from "../contract-cache.js";

const DEFAULT_PROJECT_DIR = process.cwd();

/**
 * MCP tool: stele-validate-edit
 *
 * Validate whether an edit to a file should be allowed based on
 * contract invariants and protected path patterns.
 *
 * Returns:
 * - allowed: true if the edit is allowed
 * - allowed: false if the edit should be blocked, with violations
 */
export function createValidateEditTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-validate-edit",
    description:
      "Validate whether an edit to a file should be allowed based on contract invariants. Returns allowed status and violations if blocked.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        filePath: {
          type: "string",
          description: "Path to the file being edited (absolute or relative to projectDir)",
        },
        newText: {
          type: "string",
          description: "The new file content (optional, for pre-write validation)",
        },
      },
      required: ["filePath"],
    },
    handler: (args: Record<string, unknown>): McpResult => {
      const projectDir = resolve(args.projectDir as string ?? DEFAULT_PROJECT_DIR);
      const filePath = args.filePath as string;
      const session = getSessionState(projectDir);
      const protectedPatterns = getProtectedPatterns(projectDir);

      let resolvedPath = resolve(projectDir, filePath);

      // Check if the path is protected
      if (!isProtectedPath(resolvedPath, protectedPatterns)) {
        const result: ValidateEditResult = {
          allowed: true,
          reason: "Path is not protected by Stele",
        };

        session.recordEdit(resolvedPath, result);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        };
      }

      // Path is protected — check if the file is a contract file
      // For contract files, we need to check invariants
      const result: ValidateEditResult = {
        allowed: false,
        reason: "File is protected by Stele. Use stele propose-contract to add new invariants or ask the user to approve a contract update.",
      };

      session.recordEdit(resolvedPath, result);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    },
  };
}
