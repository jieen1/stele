import { describe, expect, it } from "vitest";
import { createStopValidate } from "../../src/handlers/stop-validate.js";
import type { SteleRunResult } from "../../src/handlers/stop-validate.js";
import type { SteleConfig } from "../../src/util/stele-config-types.js";

const mockConfig: SteleConfig = {
  version: "0.1.0",
  contractDir: "contract",
  entry: "contract/main.stele",
  generatedDir: "tests/contract",
  checkerImplDir: "contract/checker_impls",
  manifestPath: "contract/.manifest.json",
  targetLanguage: "python",
  testFramework: "pytest",
  pathMode: "relative",
  protected: [],
};

function makeRunner(result: SteleRunResult) {
  return () => Promise.resolve(result);
}

const mockCtx = { projectRoot: "/tmp/project", agent: "claude-code" as const };

describe("createStopValidate", () => {
  it("allows on exit code 0", async () => {
    const hook = createStopValidate(mockConfig, makeRunner({ exitCode: 0, stdout: "{}", stderr: "" }));
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("allow");
  });

  it("denies on exit code 3 (manifest drift)", async () => {
    const hook = createStopValidate(mockConfig, makeRunner({ exitCode: 3, stdout: "{}", stderr: "" }));
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("Manifest drift");
    expect(decision.reason).toContain("stele lock");
  });

  it("denies on exit code 2 (generated drift)", async () => {
    const hook = createStopValidate(mockConfig, makeRunner({ exitCode: 2, stdout: "{}", stderr: "" }));
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
  });

  it("denies on exit code 1 (generic failure)", async () => {
    const hook = createStopValidate(mockConfig, makeRunner({ exitCode: 1, stdout: "{}", stderr: "" }));
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
  });

  it("extracts violation count from JSON report", async () => {
    const report = { violations: [{ id: "INV1" }, { id: "INV2" }] };
    const hook = createStopValidate(
      mockConfig,
      makeRunner({ exitCode: 1, stdout: JSON.stringify(report), stderr: "" }),
    );
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("2 violations");
  });

  it("handles zero violations in JSON report", async () => {
    const report = { violations: [] };
    const hook = createStopValidate(
      mockConfig,
      makeRunner({ exitCode: 1, stdout: JSON.stringify(report), stderr: "" }),
    );
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("0 violations");
  });

  it("handles singular violation", async () => {
    const report = { violations: [{ id: "INV1" }] };
    const hook = createStopValidate(
      mockConfig,
      makeRunner({ exitCode: 1, stdout: JSON.stringify(report), stderr: "" }),
    );
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("1 violation");
    expect(decision.reason).not.toContain("1 violations");
  });

  it("handles malformed JSON output gracefully", async () => {
    const hook = createStopValidate(mockConfig, makeRunner({ exitCode: 1, stdout: "not json", stderr: "" }));
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("?");
  });

  it("handles empty stdout", async () => {
    const hook = createStopValidate(mockConfig, makeRunner({ exitCode: 1, stdout: "", stderr: "" }));
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
  });

  it("handles JSON without violations key", async () => {
    const report = { ok: false, errors: ["something"] };
    const hook = createStopValidate(
      mockConfig,
      makeRunner({ exitCode: 1, stdout: JSON.stringify(report), stderr: "" }),
    );
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("?");
  });

  it("handles non-array violations", async () => {
    const report = { violations: "not-an-array" };
    const hook = createStopValidate(
      mockConfig,
      makeRunner({ exitCode: 1, stdout: JSON.stringify(report), stderr: "" }),
    );
    const decision = await hook(mockCtx);
    expect(decision.action).toBe("deny");
    expect(decision.reason).toContain("?");
  });

  it("runs stele check with --json flag", async () => {
    let capturedArgs: string[] | undefined;
    const hook = createStopValidate(
      mockConfig,
      async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    );
    await hook(mockCtx);
    expect(capturedArgs).toEqual(["check", "--json"]);
  });
});
