import type {
  HookDecision,
  PostEditHook,
  PreEditHook,
  SessionStartHook,
  StopHook,
} from "../protocol.js";

/**
 * Continue.dev adapter signature stub. The full implementation is planned
 * for Phase 3 once Continue.dev exposes a stable hook API. Methods below
 * preserve the public surface so downstream code can `import` the type
 * today and switch on agent identity.
 *
 * @remarks Calling any method throws an error with the well-known
 * `E_AGENT_NOT_IMPLEMENTED` code so callers can detect the stub and surface
 * a useful message.
 */
export class ContinueDevAdapter {
  async runPreEditHook(_hook: PreEditHook): Promise<HookDecision> {
    throw createNotImplemented("runPreEditHook");
  }

  async runPostEditHook(_hook: PostEditHook): Promise<void> {
    throw createNotImplemented("runPostEditHook");
  }

  async runSessionStartHook(_hook: SessionStartHook): Promise<{ context: string }> {
    throw createNotImplemented("runSessionStartHook");
  }

  async runStopHook(_hook: StopHook): Promise<HookDecision> {
    throw createNotImplemented("runStopHook");
  }
}

function createNotImplemented(method: string): Error {
  const err = new Error(
    `ContinueDevAdapter.${method} is not yet implemented (Phase 3 candidate). Track @stele/agent-hooks roadmap for status.`,
  );
  (err as Error & { code?: string }).code = "E_AGENT_NOT_IMPLEMENTED";
  return err;
}
