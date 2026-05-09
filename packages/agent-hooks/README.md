# @stele/agent-hooks

Editor-agnostic hook SDK for Stele.

This package defines a tiny protocol (`PreEdit`, `SessionStart`, `PostEdit`,
`Stop`), a set of reusable handler factories that implement Stele's
contract-aware policies, and adapters that bridge the protocol to specific
editor IDEs (Claude Code, Cursor; Continue.dev is a stub for Phase 3).

## Why this exists

Stele's earlier integration was a Claude Code plugin only. Other editors
(Cursor, Continue.dev) need analogous behaviour but expose very different
hook surfaces. The SDK lets handler logic stay in one place; adapters
translate to and from each editor's wire format.

## Public API

```ts
import {
  // Protocol
  type AgentHookContext,
  type HookDecision,
  type PreEditHook,
  type SessionStartHook,
  type StopHook,
  // Handler factories
  createPreEditProtect,
  createSessionStartContext,
  createStopValidate,
  createPostEditObserve,
  // Adapters
  ClaudeCodeAdapter,
  CursorAdapter,
  ContinueDevAdapter,
  // Cursor installer
  installCursor,
  uninstallCursor,
} from "@stele/agent-hooks";
```

The Cursor installer is also published under
`@stele/agent-hooks/install/cursor-installer` so the Stele CLI's
`stele install --agent cursor` command can dynamically import it.

## Adapter capability matrix

| Capability                          | Claude Code | Cursor                | Continue.dev (Phase 3) |
| ----------------------------------- | ----------- | --------------------- | ---------------------- |
| Hard PreEdit deny                   | yes         | no (best effort only) | unknown                |
| Inject SessionStart context         | yes         | via static rules      | unknown                |
| Stop validation                     | yes         | n/a                   | unknown                |
| Post-edit observation               | yes         | best effort           | unknown                |

The Cursor adapter is intentionally **soft**: Cursor cannot hard-block a
tool call. Its `.cursor/rules/stele.md` is injected into prompts and may
be ignored by the agent. Hard enforcement requires CI (e.g.
`@stele/github-action`).

## Adding a new adapter

1. Implement a class with `runPreEditHook`, `runSessionStartHook`,
   `runPostEditHook`, and (optionally) `runStopHook` methods that translate
   between the editor's wire format and `AgentHookContext`/`HookDecision`.
2. Add tests under `tests/adapters/<name>.test.ts`.
3. If the editor needs install-time setup, add an installer module under
   `src/install/<name>-installer.ts` and wire it into the CLI's
   `stele install --agent <name>` command.

## Caveats

- The Claude Code plugin's existing scripts already pass through a richer
  Claude-specific stdin extractor; the in-tree `pre-tool-protect.js` script
  delegates protected-path matching to `matchProtectedPath` from this SDK
  but keeps its own Claude payload extraction for byte-equivalent behaviour
  with the existing plugin tests.
- The `extractBashWriteTarget` utility is a simplified bash parser. The
  Claude Code plugin uses a richer in-tree parser
  (`scripts/shell-utils.js`) that supports heredocs and line continuations.
