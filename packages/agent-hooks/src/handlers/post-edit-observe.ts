import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { AgentHookContext, PostEditHook } from "../protocol.js";
import { matchProtectedPath } from "../util/path-glob.js";
import type { SteleConfig } from "../util/stele-config-types.js";

/**
 * Build a {@link PostEditHook} that records material source-edit observations
 * to `.stele/agent/session-observations.jsonl`. Mirrors the Claude Code
 * plugin's `observation-hook.js` shape: each line is a JSON observation with
 * `timestamp`, `tool_name`, `target_paths`, and `material_change`
 * (`true` for edits to non-protected, non-noise files).
 *
 * The Stop hook reads this log to decide whether to surface the maintenance
 * review prompt.
 */
export function createPostEditObserve(config: SteleConfig): PostEditHook {
  return async (ctx: AgentHookContext): Promise<void> => {
    const filePath = typeof ctx.args.filePath === "string" ? ctx.args.filePath.trim() : "";
    const targetPaths = filePath.length > 0 ? [filePath] : [];

    if (targetPaths.length === 0) {
      return;
    }

    const observation = {
      timestamp: new Date().toISOString(),
      session_id: null,
      hook_event_name: "PostToolUse",
      tool_name: ctx.tool,
      target_paths: targetPaths,
      material_change: targetPaths.some((target) => isMaterialChange(ctx.projectRoot, config.protected, target)),
    };

    const observationPath = path.join(ctx.projectRoot, ".stele", "agent", "session-observations.jsonl");
    await mkdir(path.dirname(observationPath), { recursive: true });
    await appendFile(observationPath, `${JSON.stringify(observation)}\n`, "utf8");
  };
}

function isMaterialChange(projectDir: string, protectedPatterns: readonly string[], targetPath: string): boolean {
  const relativePath = normalizeTargetPath(projectDir, targetPath);
  if (relativePath === null || relativePath.length === 0) {
    return false;
  }
  if (
    relativePath.startsWith(".stele/") ||
    relativePath.startsWith("node_modules/") ||
    relativePath.startsWith(".git/")
  ) {
    return false;
  }
  return !matchProtectedPath(targetPath, protectedPatterns, projectDir);
}

function normalizeTargetPath(projectDir: string, targetPath: string): string | null {
  const resolvedTarget = path.resolve(projectDir, targetPath);
  const relativeToProject = path.relative(projectDir, resolvedTarget);
  if (relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) {
    return null;
  }
  return relativeToProject.replaceAll("\\", "/");
}
