import { relative, resolve } from "node:path";
import { matchProtectedPath } from "@stele/agent-hooks";
import type { McpResult, ValidateEditResult } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { getSessionState } from "../session-state.js";
import { getProtectedPatterns } from "../contract-cache.js";

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
      const validated = validateProjectDir(args.projectDir);
      if (validated.error) {
        return {
          content: [{ type: "text", text: validated.error }],
          isError: true,
        };
      }
      const projectDir = validated.path!;
      const filePath = args.filePath as string;

      if (!filePath || typeof filePath !== "string") {
        return {
          content: [{ type: "text", text: "Missing required argument: filePath" }],
          isError: true,
        };
      }

      const session = getSessionState(projectDir);
      const protectedPatterns = getProtectedPatterns(projectDir);

      const resolvedPath = resolve(projectDir, filePath);

      // Containment check: reject paths that escape the project directory
      const relPath = relative(projectDir, resolvedPath);
      if (relPath.startsWith("../") || relPath.startsWith("\\..") || (process.platform !== "win32" && relPath.startsWith("/"))) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              allowed: false,
              reason: `filePath resolves outside project directory (${projectDir})`,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Check if the path is protected (delegated to agent-hooks glob matcher)
      if (!matchProtectedPath(resolvedPath, protectedPatterns, projectDir)) {
        const editResult: ValidateEditResult = {
          allowed: true,
          reason: "Path is not protected by Stele",
        };

        session.recordEdit(resolvedPath, editResult);
        return {
          content: [{ type: "text", text: JSON.stringify(editResult, null, 2) }],
          isError: false,
        };
      }

      // Path is protected — check if the file is a contract file
      // For contract files, we need to check invariants
      const editResult: ValidateEditResult = {
        allowed: false,
        reason: "File is protected by Stele. Use stele propose-contract to add new invariants or ask the user to approve a contract update.",
      };

      session.recordEdit(resolvedPath, editResult);

      return {
        content: [{ type: "text", text: JSON.stringify(editResult, null, 2) }],
        isError: false,
      };
    },
  };
}
