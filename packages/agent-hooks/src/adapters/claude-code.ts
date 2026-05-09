import type {
  AgentHookContext,
  HookDecision,
  PostEditHook,
  PreEditHook,
  SessionStartHook,
  StopHook,
  ToolKind,
} from "../protocol.js";

/**
 * Adapter that bridges Claude Code's hook stdin protocol to the
 * editor-agnostic {@link AgentHookContext}.
 *
 * Note: the in-tree `packages/claude-code-plugin/scripts/*.js` scripts are
 * thin wrappers that invoke handlers directly to keep their existing test
 * harness (which spawns the scripts) byte-equivalent. This adapter is the
 * recommended entry point for new Claude Code consumers and external
 * embeddings of the SDK.
 */
export class ClaudeCodeAdapter {
  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {}

  /**
   * Read JSON from stdin, dispatch to the hook, write the Claude Code
   * permission decision JSON on stdout, and exit with code 2 on deny.
   */
  async runPreEditHook(hook: PreEditHook): Promise<HookDecision> {
    const payload = await this.readInput();
    const ctx = this.buildContext(payload);
    const decision = await hook(ctx);

    if (decision.action === "deny") {
      this.writeOut(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason ?? "Blocked by Stele.",
          },
        }) + "\n",
      );
      this.exit(2);
    }

    if (decision.injectContext) {
      this.writeOut(decision.injectContext);
    }

    return decision;
  }

  /**
   * Read JSON from stdin, dispatch to the SessionStart hook, and emit the
   * Claude Code `additionalContext` payload on stdout.
   */
  async runSessionStartHook(hook: SessionStartHook): Promise<{ context: string }> {
    const payload = await this.readInput();
    const result = await hook({ projectRoot: this.cwd(), agent: "claude-code" });

    if (result.context.trim().length > 0) {
      this.writeOut(
        JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: this.getHookEventName(payload) ?? "SessionStart",
            additionalContext: result.context,
          },
        }) + "\n",
      );
    }

    return result;
  }

  /**
   * Read JSON from stdin, dispatch to the Stop hook, write a stop-blocking
   * message via stderr + exit 2 on deny.
   */
  async runStopHook(hook: StopHook): Promise<HookDecision> {
    await this.readInput();
    const decision = await hook({ projectRoot: this.cwd(), agent: "claude-code" });

    if (decision.action === "deny") {
      this.writeErr(`${decision.reason ?? "Blocked by Stele."}\n`);
      this.exit(2);
    }

    return decision;
  }

  /**
   * Read JSON from stdin and dispatch to the PostEdit hook. Errors are
   * swallowed because PostToolUse must not block the agent.
   */
  async runPostEditHook(hook: PostEditHook): Promise<void> {
    try {
      const payload = await this.readInput();
      const ctx = this.buildContext(payload);
      await hook(ctx);
    } catch {
      // observation hooks are async/best-effort
    }
  }

  private buildContext(payload: unknown): AgentHookContext {
    const tool = this.normalizeToolKind(this.getToolName(payload));
    const args = this.getToolInput(payload);
    return {
      agent: "claude-code",
      tool,
      args,
      projectRoot: this.cwd(),
      prompt: this.getPrompt(payload),
    };
  }

  private getToolName(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }
    const value = (payload as { tool_name?: unknown; toolName?: unknown }).tool_name
      ?? (payload as { toolName?: unknown }).toolName;
    return typeof value === "string" ? value : undefined;
  }

  private getToolInput(payload: unknown): { filePath?: string; command?: string; [key: string]: unknown } {
    if (typeof payload !== "object" || payload === null) {
      return {};
    }
    const input = (payload as { tool_input?: unknown; input?: unknown }).tool_input
      ?? (payload as { input?: unknown }).input;
    if (typeof input !== "object" || input === null) {
      return {};
    }
    const obj = input as Record<string, unknown>;
    const result: { filePath?: string; command?: string; [key: string]: unknown } = { ...obj };
    const candidates = [obj.file_path, obj.path, obj.target_path, obj.notebook_path];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        result.filePath = candidate;
        break;
      }
    }
    if (typeof obj.command === "string") {
      result.command = obj.command;
    }
    return result;
  }

  private getPrompt(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }
    const value = (payload as { prompt?: unknown }).prompt;
    return typeof value === "string" ? value : undefined;
  }

  private getHookEventName(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }
    const value = (payload as { hook_event_name?: unknown; hookEventName?: unknown }).hook_event_name
      ?? (payload as { hookEventName?: unknown }).hookEventName;
    return typeof value === "string" ? value : undefined;
  }

  private normalizeToolKind(toolName: string | undefined): ToolKind {
    if (!toolName) {
      return "unknown";
    }
    const lower = toolName.toLowerCase();
    if (lower === "bash") {
      return "bash";
    }
    if (lower === "read" || lower === "grep" || lower === "glob") {
      return lower === "read" ? "read" : "search";
    }
    if (lower === "write") {
      return "write";
    }
    if (lower === "edit" || lower === "multiedit" || lower === "notebookedit") {
      return "edit";
    }
    return toolName;
  }

  private async readInput(): Promise<unknown> {
    const text = await readStdin(this.options.stdin ?? process.stdin);
    if (text.trim().length === 0) {
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  private writeOut(value: string): void {
    (this.options.stdout ?? process.stdout).write(value);
  }

  private writeErr(value: string): void {
    (this.options.stderr ?? process.stderr).write(value);
  }

  private exit(code: number): never {
    (this.options.exit ?? ((c: number) => process.exit(c)))(code);
    // for type-checking: process.exit returns never, but options.exit might not
    throw new Error(`exit(${code})`);
  }

  private cwd(): string {
    return this.options.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  }
}

/**
 * Optional dependency injection points for {@link ClaudeCodeAdapter}.
 * Tests pass mock streams; production callers leave these undefined.
 */
export interface ClaudeCodeAdapterOptions {
  /** Override stdin (default: process.stdin). */
  stdin?: NodeJS.ReadableStream;
  /** Override stdout (default: process.stdout). */
  stdout?: { write: (chunk: string) => unknown };
  /** Override stderr (default: process.stderr). */
  stderr?: { write: (chunk: string) => unknown };
  /** Override process.exit (default: process.exit). */
  exit?: (code: number) => void;
  /** Override the resolved project root (default: CLAUDE_PROJECT_DIR or cwd). */
  cwd?: string;
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString("utf8"));
  }
  return chunks.join("");
}
