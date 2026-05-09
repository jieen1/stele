import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code.js";
import type { PreEditHook, SessionStartHook, StopHook } from "../../src/protocol.js";

interface RunResult {
  decision: unknown;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  threwExit: boolean;
}

function makeAdapter(stdinPayload: unknown, cwd = "/tmp/proj"): { adapter: ClaudeCodeAdapter; result: RunResult } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const result: RunResult = {
    decision: undefined,
    stdout: "",
    stderr: "",
    exitCode: null,
    threwExit: false,
  };

  const adapter = new ClaudeCodeAdapter({
    stdin: Readable.from([JSON.stringify(stdinPayload)]),
    stdout: { write: (chunk: string) => stdoutChunks.push(chunk) },
    stderr: { write: (chunk: string) => stderrChunks.push(chunk) },
    cwd,
    exit: (code: number) => {
      result.exitCode = code;
      throw new Error(`__exit:${code}`);
    },
  });

  return {
    adapter,
    result: new Proxy(result, {
      get(target, key) {
        if (key === "stdout") return stdoutChunks.join("");
        if (key === "stderr") return stderrChunks.join("");
        return Reflect.get(target, key);
      },
    }),
  };
}

describe("ClaudeCodeAdapter", () => {
  it("dispatches PreEditHook and exits 2 on deny", async () => {
    const { adapter, result } = makeAdapter({
      tool_name: "Edit",
      tool_input: { file_path: "contract/main.stele" },
    });

    const denyHook: PreEditHook = async (ctx) => {
      expect(ctx.agent).toBe("claude-code");
      expect(ctx.tool).toBe("edit");
      expect(ctx.args.filePath).toBe("contract/main.stele");
      return { action: "deny", reason: "blocked" };
    };

    await expect(adapter.runPreEditHook(denyHook)).rejects.toThrow(/__exit:2/u);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("permissionDecision");
    expect(result.stdout).toContain("deny");
    expect(result.stdout).toContain("blocked");
  });

  it("dispatches PreEditHook and produces no stdout on allow", async () => {
    const { adapter, result } = makeAdapter({
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts" },
    });

    const allowHook: PreEditHook = async () => ({ action: "allow" });
    const decision = await adapter.runPreEditHook(allowHook);

    expect(decision.action).toBe("allow");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBeNull();
  });

  it("normalizes Bash tool kind", async () => {
    const { adapter } = makeAdapter({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });

    const captured: { tool?: string; command?: string } = {};
    const hook: PreEditHook = async (ctx) => {
      captured.tool = ctx.tool;
      captured.command = ctx.args.command;
      return { action: "allow" };
    };
    await adapter.runPreEditHook(hook);
    expect(captured.tool).toBe("bash");
    expect(captured.command).toBe("echo hi");
  });

  it("emits SessionStart additionalContext payload when context is non-empty", async () => {
    const { adapter, result } = makeAdapter({ hook_event_name: "SessionStart", session_id: "s1" });
    const hook: SessionStartHook = async () => ({ context: "hello world" });

    await adapter.runSessionStartHook(hook);

    expect(result.stdout).toContain("hookSpecificOutput");
    expect(result.stdout).toContain("SessionStart");
    expect(result.stdout).toContain("hello world");
  });

  it("emits no SessionStart payload when context is empty", async () => {
    const { adapter, result } = makeAdapter({ hook_event_name: "SessionStart" });
    const hook: SessionStartHook = async () => ({ context: "" });
    await adapter.runSessionStartHook(hook);
    expect(result.stdout).toBe("");
  });

  it("Stop hook deny writes reason to stderr and exits 2", async () => {
    const { adapter, result } = makeAdapter({});
    const hook: StopHook = async () => ({ action: "deny", reason: "violations remain" });
    await expect(adapter.runStopHook(hook)).rejects.toThrow(/__exit:2/u);
    expect(result.stderr).toContain("violations remain");
    expect(result.exitCode).toBe(2);
  });

  it("Stop hook allow returns silently with exit code 0 (process.exit not called)", async () => {
    const { adapter, result } = makeAdapter({});
    const hook: StopHook = async () => ({ action: "allow" });
    const decision = await adapter.runStopHook(hook);
    expect(decision.action).toBe("allow");
    expect(result.exitCode).toBeNull();
  });

  it("PostEdit hook swallows errors", async () => {
    const { adapter } = makeAdapter({
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts" },
    });
    const hook = async (): Promise<void> => {
      throw new Error("boom");
    };
    await expect(adapter.runPostEditHook(hook)).resolves.toBeUndefined();
  });
});
