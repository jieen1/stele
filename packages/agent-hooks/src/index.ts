/**
 * @stele/agent-hooks barrel.
 *
 * Public API for editor-agnostic Stele hooks. Adapters for specific IDEs
 * are exported from `./adapters/<name>` and the per-IDE installer (if any)
 * from `./install/<name>-installer`.
 */

// Protocol types.
export type {
  AgentHookContext,
  AgentId,
  HookDecision,
  PostEditHook,
  PreEditHook,
  SessionStartHook,
  StopHook,
  ToolArgs,
  ToolKind,
} from "./protocol.js";

// Handler factories.
export { createPreEditProtect } from "./handlers/pre-edit-protect.js";
export { createSessionStartContext } from "./handlers/session-start-context.js";
export { createStopValidate, type SteleRunResult } from "./handlers/stop-validate.js";
export { createPostEditObserve } from "./handlers/post-edit-observe.js";

// Adapters.
export { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "./adapters/claude-code.js";
export { CursorAdapter, type CursorToolPayload } from "./adapters/cursor.js";
export { ContinueDevAdapter } from "./adapters/continue-dev.js";

// Installers.
export {
  install as installCursor,
  uninstall as uninstallCursor,
  renderRulesMarkdown as renderCursorRulesMarkdown,
  AUTO_MARKER as CURSOR_AUTO_MARKER,
  type CursorInstallOptions,
} from "./install/cursor-installer.js";

// Utilities.
export { matchProtectedPath } from "./util/path-glob.js";
export { extractBashWriteTarget } from "./util/bash-write-target.js";
