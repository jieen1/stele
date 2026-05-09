import type {
  AgentHookContext,
  HookDecision,
  PostEditHook,
  PreEditHook,
  SessionStartHook,
} from "../protocol.js";

/**
 * Adapter that bridges Cursor's static-rules and composer-rule shell hooks
 * to the editor-agnostic {@link AgentHookContext}.
 *
 * **Cursor enforcement caveat (best effort).** Cursor does not expose a
 * Claude Code-equivalent `PreToolUse` hook with hard `deny` semantics.
 * Static rules under `.cursor/rules/*.md` are merely injected into the
 * prompt; the agent may ignore them. The composer-rule shell mechanism
 * (when enabled) runs *after* a user command but cannot pre-empt a tool
 * call. Real enforcement lives in CDL + CI (`@stele/github-action`).
 *
 * This adapter exposes the protocol surface so SDK consumers can write
 * portable handlers, and provides a `runComposerHook` entry point for the
 * shell wrapper installed by `stele install --agent cursor --enable-shell`.
 */
export class CursorAdapter {
  /**
   * Translate a structured tool payload (e.g. surfaced via composer hook
   * env vars) into an {@link AgentHookContext} and dispatch the PreEdit
   * hook. Cursor will not honour a hard deny; consumers should treat the
   * decision as advisory and surface it via stdout.
   */
  async runPreEditHook(hook: PreEditHook, payload: CursorToolPayload): Promise<HookDecision> {
    return hook(this.buildContext(payload));
  }

  /** Render a SessionStart context blob for inclusion in the static rules file. */
  async runSessionStartHook(hook: SessionStartHook, projectRoot: string): Promise<{ context: string }> {
    return hook({ projectRoot, agent: "cursor" });
  }

  /** Dispatch a PostEdit hook (best effort; errors swallowed). */
  async runPostEditHook(hook: PostEditHook, payload: CursorToolPayload): Promise<void> {
    try {
      await hook(this.buildContext(payload));
    } catch {
      // observation hooks are best-effort
    }
  }

  /**
   * Composer-rule shell hook entry point. Reads CURSOR_FILE / CURSOR_TOOL
   * style env vars (mirrors the script written by `cursor-installer`) and
   * dispatches the PreEdit hook. Returns the decision so callers can decide
   * whether to print a warning or exit non-zero.
   */
  async runComposerHook(hook: PreEditHook, env: NodeJS.ProcessEnv, projectRoot: string): Promise<HookDecision> {
    const payload: CursorToolPayload = {
      tool: env.CURSOR_TOOL ?? "edit",
      filePath: env.CURSOR_FILE,
      command: env.CURSOR_COMMAND,
      projectRoot,
    };
    return this.runPreEditHook(hook, payload);
  }

  private buildContext(payload: CursorToolPayload): AgentHookContext {
    return {
      agent: "cursor",
      tool: payload.tool ?? "edit",
      args: {
        filePath: payload.filePath,
        command: payload.command,
        ...(payload.extra ?? {}),
      },
      projectRoot: payload.projectRoot,
      prompt: payload.prompt,
    };
  }
}

/** Structured payload Cursor adapters convert into an {@link AgentHookContext}. */
export interface CursorToolPayload {
  tool?: string;
  filePath?: string;
  command?: string;
  projectRoot: string;
  prompt?: string;
  extra?: Record<string, unknown>;
}
