import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentHookContext } from "../../src/protocol.js";
import type { SteleConfig } from "../../src/util/stele-config-types.js";

// Self-contained mock factory (hoist-safe)
vi.mock("node:fs/promises", () => {
  const mkdir = vi.fn();
  mkdir.mockResolvedValue(undefined);
  const appendFile = vi.fn();
  appendFile.mockResolvedValue(undefined);
  return { mkdir, appendFile };
});

import * as fsPromises from "node:fs/promises";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkdirMock: any = vi.mocked(fsPromises.mkdir, true);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const appendFileMock: any = vi.mocked(fsPromises.appendFile, true);

import { createPostEditObserve } from "../../src/handlers/post-edit-observe.js";

function getObservation(): Record<string, unknown> {
  const call = appendFileMock.mock.calls[0];
  const content = call[1];
  return JSON.parse((content as string).replace(/\n$/, ""));
}

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
  protected: [
    "contract/**/*.stele",
    "contract/checker_impls/**/*",
    "contract/.baseline.json",
    "contract/.manifest.json",
    "tests/contract/**/*",
  ],
};

function makeCtx(partial: Partial<AgentHookContext>): AgentHookContext {
  return {
    agent: "claude-code",
    tool: "edit",
    args: {},
    projectRoot: "/project",
    ...partial,
  };
}

describe("createPostEditObserve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirMock.mockResolvedValue(undefined);
    appendFileMock.mockResolvedValue(undefined);
  });

  it("writes observation for material change", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: "src/app.py" } }));

    expect(mkdirMock).toHaveBeenCalled();
    expect(appendFileMock).toHaveBeenCalled();
    const obs = getObservation();
    expect(obs.material_change).toBe(true);
    expect(obs.tool_name).toBe("write");
  });

  it("marks material_change false for .stele/ directory", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: ".stele/agent/data.json" } }));

    const obs = getObservation();
    expect(obs.material_change).toBe(false);
  });

  it("marks material_change false for node_modules", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: "node_modules/something.txt" } }));

    const obs = getObservation();
    expect(obs.material_change).toBe(false);
  });

  it("marks material_change false for .git directory", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: ".git/config" } }));

    const obs = getObservation();
    expect(obs.material_change).toBe(false);
  });

  it("marks material_change false for protected paths", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: "contract/main.stele" } }));

    const obs = getObservation();
    expect(obs.material_change).toBe(false);
  });

  it("includes correct tool_name in observation", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "bash", args: { filePath: "src/app.py" } }));

    const obs = getObservation();
    expect(obs.tool_name).toBe("bash");
  });

  it("handles non-string filePath gracefully", async () => {
    const hook = createPostEditObserve(mockConfig);
    // @ts-expect-error testing non-string input
    await hook(makeCtx({ tool: "write", args: { filePath: 123 } }));
    expect(appendFileMock).not.toHaveBeenCalled();
  });

  it("handles empty filePath", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: "" } }));
    expect(appendFileMock).not.toHaveBeenCalled();
  });

  it("has timestamp in observation", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: "src/app.py" } }));

    const obs = getObservation();
    expect(obs.timestamp).toBeDefined();
    const ts = obs.timestamp as string;
    expect(() => new Date(ts)).not.toThrow();
  });

  it("writes to correct observation path", async () => {
    const hook = createPostEditObserve(mockConfig);
    await hook(makeCtx({ tool: "write", args: { filePath: "src/app.py" } }));

    const call = mkdirMock.mock.calls[0];
    const dirPath = call[0] as string;
    expect(dirPath).toContain(".stele");
    expect(dirPath).toContain("agent");
  });
});
