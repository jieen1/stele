import { describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";

function makeStubs(mode: string) {
  const calls: string[] = [];
  const setFailed = vi.fn((message: string) => {
    calls.push(`setFailed:${message}`);
  });
  const runCheck = vi.fn(async () => {
    calls.push("runCheck");
  });
  const runGenerate = vi.fn(async () => {
    calls.push("runGenerate");
  });
  const runReverify = vi.fn(async () => {
    calls.push("runReverify");
  });
  const getInput = vi.fn((name: string) => (name === "mode" ? mode : ""));
  return { calls, setFailed, runCheck, runGenerate, runReverify, getInput };
}

describe("main dispatcher", () => {
  it("invokes runCheck when mode=check", async () => {
    const stubs = makeStubs("check");
    await main(stubs);
    expect(stubs.runCheck).toHaveBeenCalledTimes(1);
    expect(stubs.runGenerate).not.toHaveBeenCalled();
    expect(stubs.setFailed).not.toHaveBeenCalled();
  });

  it("invokes runGenerate when mode=generate", async () => {
    const stubs = makeStubs("generate");
    await main(stubs);
    expect(stubs.runGenerate).toHaveBeenCalledTimes(1);
    expect(stubs.runCheck).not.toHaveBeenCalled();
    expect(stubs.setFailed).not.toHaveBeenCalled();
  });

  it("rejects mode=lock with the explicit removal message", async () => {
    const stubs = makeStubs("lock");
    await main(stubs);
    expect(stubs.runCheck).not.toHaveBeenCalled();
    expect(stubs.runGenerate).not.toHaveBeenCalled();
    expect(stubs.setFailed).toHaveBeenCalledTimes(1);
    const message = stubs.setFailed.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("mode=lock is not supported");
    expect(message).toContain("removed");
    expect(message).toContain("workflow_dispatch");
  });

  it("invokes runReverify when mode=reverify", async () => {
    const stubs = makeStubs("reverify");
    await main(stubs);
    expect(stubs.runReverify).toHaveBeenCalledTimes(1);
    expect(stubs.runCheck).not.toHaveBeenCalled();
    expect(stubs.setFailed).not.toHaveBeenCalled();
  });

  it("rejects unsupported modes with allowed values", async () => {
    const stubs = makeStubs("foo");
    await main(stubs);
    expect(stubs.setFailed).toHaveBeenCalledWith(
      "Unsupported mode: foo. Allowed: check | generate | reverify.",
    );
  });

  it("treats empty input as check (default)", async () => {
    const stubs = makeStubs("");
    await main(stubs);
    expect(stubs.runCheck).toHaveBeenCalledTimes(1);
  });

  it("forwards thrown errors via setFailed", async () => {
    const stubs = makeStubs("check");
    stubs.runCheck.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await main(stubs);
    expect(stubs.setFailed).toHaveBeenCalledWith("Stele Action failed: boom");
  });
});
