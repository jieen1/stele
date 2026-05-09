/**
 * Agent-agnostic hook protocol shared by all Stele editor integrations.
 *
 * Adapters (claude-code, cursor, continue-dev, ...) translate their native
 * hook payloads into {@link AgentHookContext} and dispatch to handlers
 * produced by the factories in {@link "../handlers/"}. Handlers return a
 * {@link HookDecision} that adapters serialize back to their host.
 */

/** Stable identifier for the host agent IDE. Open-ended for third-party adapters. */
export type AgentId = "claude-code" | "cursor" | "continue-dev" | (string & {});

/** Logical kind of editor tool action being intercepted. */
export type ToolKind = "read" | "write" | "edit" | "bash" | "search" | (string & {});

/** Normalized tool arguments. Adapters MAY add extra keys. */
export interface ToolArgs {
  /** Target file path for read/write/edit tools. */
  filePath?: string;
  /** Shell command for bash-style tools. */
  command?: string;
  /** Adapter-specific extras (notebook paths, MCP args, etc.). */
  [key: string]: unknown;
}

/** Context passed to every hook callback. */
export interface AgentHookContext {
  /** Agent IDE identifier. */
  agent: AgentId;
  /** Tool kind. */
  tool: ToolKind;
  /** Tool arguments (already adapter-normalized). */
  args: ToolArgs;
  /** Project root used for config lookup. */
  projectRoot: string;
  /** User prompt, if exposed by the host agent. */
  prompt?: string;
}

/** Verdict returned by a hook back to the host agent. */
export interface HookDecision {
  /** Allow, deny (block tool), or warn (allow but surface message). */
  action: "allow" | "deny" | "warn";
  /** Human-readable reason; required when action is "deny" or "warn". */
  reason?: string;
  /** Additional text to inject into the agent context (lifecycle hooks). */
  injectContext?: string;
}

/** Hook signature invoked before a write/edit/bash tool runs. */
export type PreEditHook = (ctx: AgentHookContext) => Promise<HookDecision>;

/** Hook signature invoked after a tool successfully runs (observation only). */
export type PostEditHook = (ctx: AgentHookContext) => Promise<void>;

/** Hook signature invoked at session start to inject contract context. */
export type SessionStartHook = (
  ctx: { projectRoot: string; agent: AgentId },
) => Promise<{ context: string }>;

/** Hook signature invoked when the agent finishes a turn. */
export type StopHook = (
  ctx: { projectRoot: string; agent: AgentId },
) => Promise<HookDecision>;
