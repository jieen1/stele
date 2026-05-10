import type { AgentHookContext, HookDecision, PreEditHook } from "../protocol.js";
import { extractBashWriteTarget } from "../util/bash-write-target.js";
import { KNOWN_SAFE_COMMANDS } from "../util/known-safe-commands.js";
import { matchProtectedPath } from "../util/path-glob.js";
import type { SteleConfig } from "../util/stele-config-types.js";

/**
 * Build a {@link PreEditHook} that denies edits to paths matching
 * `config.protected`. Mirrors the behaviour of the Claude Code plugin's
 * `pre-tool-protect.js` script, but expressed in terms of the
 * editor-agnostic {@link AgentHookContext}.
 *
 * Behaviour:
 * - `read` / `search` / unknown tools: always allow.
 * - `write` / `edit` with `args.filePath`: deny when the path matches a
 *   protected glob (relative or absolute traversal into the project).
 * - `bash` with `args.command`: deny when the parsed redirect/tee/cp/mv
 *   target lands on a protected path.
 *
 * Bash parsing in this SDK is intentionally conservative; the Claude Code
 * adapter delegates to the richer in-tree parser to preserve test parity.
 */
export function createPreEditProtect(config: SteleConfig): PreEditHook {
  return async (ctx: AgentHookContext): Promise<HookDecision> => {
    if (ctx.tool !== "write" && ctx.tool !== "edit" && ctx.tool !== "bash") {
      return { action: "allow" };
    }

    const target = typeof ctx.args.filePath === "string" ? ctx.args.filePath.trim() : "";

    if (target.length === 0 && ctx.tool === "bash") {
      const command = typeof ctx.args.command === "string" ? ctx.args.command : "";
      const bashTarget = extractBashWriteTarget(command);
      if (!bashTarget) {
        // Write target could not be determined. Deny unless the command is
        // a known read-only command. This closes the bypass where heredocs,
        // $() substitution, python3 -c, sed -i, etc. would slip through.
        const firstToken = extractBashFirstToken(command);
        if (
          firstToken !== null &&
          KNOWN_SAFE_COMMANDS.has(firstToken)
        ) {
          return { action: "allow" };
        }
        return {
          action: "deny",
          reason:
            `Bash command target could not be determined and "${firstToken ?? "(empty)"}" is ` +
            "not in the known-safe-commands allowlist. Denying by default.",
        };
      }
      if (matchProtectedPath(bashTarget, config.protected, ctx.projectRoot)) {
        return {
          action: "deny",
          reason: `Bash command would modify protected path: ${bashTarget}. See ${config.contractDir}/main.stele.`,
        };
      }
      return { action: "allow" };
    }

    if (target.length > 0 && matchProtectedPath(target, config.protected, ctx.projectRoot)) {
      return {
        action: "deny",
        reason:
          `Direct edit to protected path "${target}" is not allowed. ` +
          "Use `stele propose invariant` for additions; modifications require human review.",
      };
    }

    return { action: "allow" };
  };
}

/**
 * Extract the first whitespace-delimited token from a bash command string.
 * Used to determine which executable is being invoked for allowlist matching.
 */
function extractBashFirstToken(command: string): string | null {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  const spaceIndex = trimmed.search(/\s/);
  return spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
}
