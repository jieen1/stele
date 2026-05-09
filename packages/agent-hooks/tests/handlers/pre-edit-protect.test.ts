import { describe, expect, it } from "vitest";
import { createPreEditProtect } from "../../src/handlers/pre-edit-protect.js";
import type { AgentHookContext } from "../../src/protocol.js";
import { DEFAULT_CONFIG, type SteleConfig } from "@stele/cli";

const PROJECT_ROOT = "/tmp/project";

function makeConfig(overrides: Partial<SteleConfig> = {}): SteleConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeCtx(partial: Partial<AgentHookContext>): AgentHookContext {
  return {
    agent: "cursor",
    tool: "edit",
    args: {},
    projectRoot: PROJECT_ROOT,
    ...partial,
  };
}

describe("createPreEditProtect", () => {
  it("denies write to contract/main.stele", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "write", args: { filePath: "contract/main.stele" } }),
    );
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("contract/main.stele");
    expect(decision.reason).toContain("stele propose invariant");
  });

  it("denies edit to contract/.manifest.json", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "edit", args: { filePath: "contract/.manifest.json" } }),
    );
    expect(decision.action).toBe("deny");
  });

  it("denies edit to tests/contract/test_x.py", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "edit", args: { filePath: "tests/contract/test_x.py" } }),
    );
    expect(decision.action).toBe("deny");
  });

  it("allows write to src/foo.ts", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(makeCtx({ tool: "write", args: { filePath: "src/foo.ts" } }));
    expect(decision.action).toBe("allow");
  });

  it("allows read on protected paths", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "read", args: { filePath: "contract/main.stele" } }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows search on any path", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "search", args: { filePath: "contract/main.stele" } }),
    );
    expect(decision.action).toBe("allow");
  });

  it("denies bash redirect into protected path", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({
        tool: "bash",
        args: { command: "echo hello > contract/main.stele" },
      }),
    );
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("contract/main.stele");
  });

  it("denies bash append into protected path", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({
        tool: "bash",
        args: { command: "echo hello >> tests/contract/foo.py" },
      }),
    );
    expect(decision.action).toBe("deny");
  });

  it("denies bash cp into protected path", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({
        tool: "bash",
        args: { command: "cp /etc/hosts contract/main.stele" },
      }),
    );
    expect(decision.action).toBe("deny");
  });

  it("allows bash with no write target", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "bash", args: { command: "ls -la" } }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows bash echo into non-protected path", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "bash", args: { command: "echo hello > /tmp/x.txt" } }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows when filePath is empty for write/edit", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(makeCtx({ tool: "write", args: {} }));
    expect(decision.action).toBe("allow");
  });

  it("respects a custom protected pattern", async () => {
    const hook = createPreEditProtect(makeConfig({ protected: ["secrets/**/*"] }));
    expect(
      (await hook(makeCtx({ tool: "write", args: { filePath: "secrets/key.pem" } }))).action,
    ).toBe("deny");
    expect(
      (await hook(makeCtx({ tool: "write", args: { filePath: "src/foo.ts" } }))).action,
    ).toBe("allow");
  });

  it("denies subtree-protected directory root edits", async () => {
    const hook = createPreEditProtect(makeConfig());
    const decision = await hook(
      makeCtx({ tool: "write", args: { filePath: "tests/contract" } }),
    );
    expect(decision.action).toBe("deny");
  });

  it("allows non-subtree-protected siblings under contract/", async () => {
    const hook = createPreEditProtect(makeConfig());
    expect(
      (await hook(makeCtx({ tool: "write", args: { filePath: "contract/notes.txt" } }))).action,
    ).toBe("allow");
  });
});
