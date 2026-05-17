import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SteleConfig } from "../../src/util/stele-config-types.js";

// Mock @stele/core BEFORE importing the handler
const mockLoadContract = vi.fn();
vi.mock("@stele/core", () => ({
  loadContract: () => mockLoadContract(),
}));

import { createSessionStartContext } from "../../src/handlers/session-start-context.js";

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

const mockCtx = { projectRoot: "/project", agent: "claude-code" as const };

describe("createSessionStartContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("produces context with invariants", async () => {
    mockLoadContract.mockResolvedValue({
      invariants: [
        { id: "INV1", severity: "error", description: "Email must be valid" },
        { id: "INV2", severity: "warning", description: "Name must not be empty" },
      ],
    });

    const hook = createSessionStartContext(mockConfig);
    const result = await hook(mockCtx);

    expect(result.context).toContain("2 invariants");
    expect(result.context).toContain("**INV1**");
    expect(result.context).toContain("**INV2**");
  });

  it("handles zero invariants", async () => {
    mockLoadContract.mockResolvedValue({ invariants: [] });

    const hook = createSessionStartContext(mockConfig);
    const result = await hook(mockCtx);

    expect(result.context).toContain("0 invariants");
    expect(result.context).toContain("_(none)_");
  });

  it("returns empty context on loadContract failure", async () => {
    mockLoadContract.mockRejectedValue(new Error("file not found"));

    const hook = createSessionStartContext(mockConfig);
    const result = await hook(mockCtx);

    expect(result.context).toBe("");
  });

  it("includes propose instruction", async () => {
    mockLoadContract.mockResolvedValue({ invariants: [] });

    const hook = createSessionStartContext(mockConfig);
    const result = await hook(mockCtx);

    expect(result.context).toContain("stele propose");
  });

  it("includes protected paths in context", async () => {
    mockLoadContract.mockResolvedValue({ invariants: [] });

    const hook = createSessionStartContext(mockConfig);
    const result = await hook(mockCtx);

    expect(result.context).toContain("contract/**/*.stele");
    expect(result.context).toContain("tests/contract/**/*");
  });

  it("caps summary at 30 invariants", async () => {
    const manyInvariants = Array.from({ length: 35 }, (_, i) => ({
      id: `INV${i}`,
      severity: "error",
      description: `Description ${i}`,
    }));
    mockLoadContract.mockResolvedValue({ invariants: manyInvariants });

    const hook = createSessionStartContext(mockConfig);
    const result = await hook(mockCtx);

    expect(result.context).toContain("_(+ 5 more)_");
  });
});
