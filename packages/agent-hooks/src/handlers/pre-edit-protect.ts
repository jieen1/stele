import type { AgentHookContext, HookDecision, PreEditHook } from "../protocol.js";
import { extractBashWriteTarget } from "../util/bash-write-target.js";
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
        return { action: "allow" };
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
