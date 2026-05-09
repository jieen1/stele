import { describe, expect, it } from "vitest";
import { CursorAdapter } from "../../src/adapters/cursor.js";
import type { PreEditHook } from "../../src/protocol.js";

describe("CursorAdapter", () => {
  const adapter = new CursorAdapter();

  it("translates a file payload into AgentHookContext for the hook", async () => {
    const calls: Array<{ tool: string; filePath?: string; agent: string }> = [];
    const hook: PreEditHook = async (ctx) => {
      calls.push({ tool: ctx.tool, filePath: ctx.args.filePath, agent: ctx.agent });
      return { action: "allow" };
    };

    await adapter.runPreEditHook(hook, {
      tool: "edit",
      filePath: "src/foo.ts",
      projectRoot: "/tmp/project",
    });

    expect(calls).toEqual([{ tool: "edit", filePath: "src/foo.ts", agent: "cursor" }]);
  });

  it("returns the underlying decision (allow)", async () => {
    const hook: PreEditHook = async () => ({ action: "allow" });
    const decision = await adapter.runPreEditHook(hook, { projectRoot: "/p" });
    expect(decision.action).toBe("allow");
  });

  it("returns the underlying decision (deny) without throwing", async () => {
    const hook: PreEditHook = async () => ({ action: "deny", reason: "blocked" });
    const decision = await adapter.runPreEditHook(hook, {
      filePath: "contract/main.stele",
      projectRoot: "/p",
    });
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("blocked");
  });

  it("dispatches composer-rule env vars to the hook", async () => {
    const seen: string[] = [];
    const hook: PreEditHook = async (ctx) => {
      seen.push(ctx.args.filePath ?? "<none>");
      return { action: "allow" };
    };

    await adapter.runComposerHook(
      hook,
      { CURSOR_TOOL: "edit", CURSOR_FILE: "src/payments.ts" },
      "/tmp/repo",
    );

    expect(seen).toEqual(["src/payments.ts"]);
  });

  it("forwards extra payload fields onto args", async () => {
    let captured: Record<string, unknown> | null = null;
    const hook: PreEditHook = async (ctx) => {
      captured = ctx.args as Record<string, unknown>;
      return { action: "allow" };
    };
    await adapter.runPreEditHook(hook, {
      tool: "edit",
      filePath: "src/x.ts",
      projectRoot: "/p",
      extra: { compositionId: "abc" },
    });
    expect(captured).toMatchObject({ filePath: "src/x.ts", compositionId: "abc" });
  });

  it("post-edit hook errors are swallowed", async () => {
    const failing = async (): Promise<void> => {
      throw new Error("boom");
    };
    await expect(
      adapter.runPostEditHook(failing, { filePath: "src/x.ts", projectRoot: "/p" }),
    ).resolves.toBeUndefined();
  });
});
