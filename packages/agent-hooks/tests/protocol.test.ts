import { describe, expect, it } from "vitest";
import type {
  AgentHookContext,
  AgentId,
  HookDecision,
  PostEditHook,
  PreEditHook,
  SessionStartHook,
  StopHook,
  ToolKind,
} from "../src/protocol.js";

describe("protocol type shapes", () => {
  it("AgentHookContext is structurally usable from a literal", () => {
    const ctx: AgentHookContext = {
      agent: "claude-code",
      tool: "edit",
      args: { filePath: "src/foo.ts" },
      projectRoot: "/tmp/project",
    };
    expect(ctx.agent).toBe("claude-code");
    expect(ctx.tool).toBe("edit");
    expect(ctx.args.filePath).toBe("src/foo.ts");
  });

  it("AgentId accepts known and arbitrary string identifiers", () => {
    const known: AgentId = "cursor";
    const custom: AgentId = "my-agent";
    expect(known).toBe("cursor");
    expect(custom).toBe("my-agent");
  });

  it("ToolKind accepts known and arbitrary string tools", () => {
    const known: ToolKind = "bash";
    const custom: ToolKind = "mcp__some__tool";
    expect(known).toBe("bash");
    expect(custom).toBe("mcp__some__tool");
  });

  it("HookDecision allows allow/deny/warn with optional reason", () => {
    const allow: HookDecision = { action: "allow" };
    const deny: HookDecision = { action: "deny", reason: "blocked" };
    const warn: HookDecision = { action: "warn", reason: "advisory" };
    const inject: HookDecision = { action: "allow", injectContext: "extra" };
    expect(allow.action).toBe("allow");
    expect(deny.reason).toBe("blocked");
    expect(warn.action).toBe("warn");
    expect(inject.injectContext).toBe("extra");
  });

  it("PreEditHook is an async function returning a HookDecision", async () => {
    const hook: PreEditHook = async (ctx) => ({ action: "allow", reason: ctx.tool });
    const decision = await hook({
      agent: "cursor",
      tool: "edit",
      args: {},
      projectRoot: "/x",
    });
    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("edit");
  });

  it("SessionStartHook returns a context string", async () => {
    const hook: SessionStartHook = async () => ({ context: "hello" });
    const result = await hook({ projectRoot: "/x", agent: "cursor" });
    expect(result.context).toBe("hello");
  });

  it("StopHook returns a HookDecision", async () => {
    const hook: StopHook = async () => ({ action: "allow" });
    const decision = await hook({ projectRoot: "/x", agent: "cursor" });
    expect(decision.action).toBe("allow");
  });

  it("PostEditHook returns void", async () => {
    let called = false;
    const hook: PostEditHook = async () => {
      called = true;
    };
    await hook({ agent: "cursor", tool: "edit", args: {}, projectRoot: "/x" });
    expect(called).toBe(true);
  });
});
