import { describe, expect, it } from "vitest";
import { ContinueDevAdapter } from "../../src/adapters/continue-dev.js";
import type {
  PostEditHook,
  PreEditHook,
  SessionStartHook,
  StopHook,
} from "../../src/protocol.js";

describe("ContinueDevAdapter", () => {
  const adapter = new ContinueDevAdapter();

  it("runPreEditHook throws E_AGENT_NOT_IMPLEMENTED", async () => {
    const hook: PreEditHook = async () => ({ action: "allow" });
    const err = await adapter.runPreEditHook(hook).catch((e: Error) => e);
    expect((err as Error & { code?: string }).code).toBe("E_AGENT_NOT_IMPLEMENTED");
  });

  it("runPostEditHook throws E_AGENT_NOT_IMPLEMENTED", async () => {
    const hook: PostEditHook = async () => {};
    const err = await adapter.runPostEditHook(hook).catch((e: Error) => e);
    expect((err as Error & { code?: string }).code).toBe("E_AGENT_NOT_IMPLEMENTED");
  });

  it("runSessionStartHook throws E_AGENT_NOT_IMPLEMENTED", async () => {
    const hook: SessionStartHook = async () => ({ context: "" });
    const err = await adapter.runSessionStartHook(hook).catch((e: Error) => e);
    expect((err as Error & { code?: string }).code).toBe("E_AGENT_NOT_IMPLEMENTED");
  });

  it("runStopHook throws E_AGENT_NOT_IMPLEMENTED", async () => {
    const hook: StopHook = async () => ({ action: "allow" });
    const err = await adapter.runStopHook(hook).catch((e: Error) => e);
    expect((err as Error & { code?: string }).code).toBe("E_AGENT_NOT_IMPLEMENTED");
  });
});
