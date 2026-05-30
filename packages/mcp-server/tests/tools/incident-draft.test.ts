import { describe, it, expect, beforeEach, vi } from "vitest";

const mockRunIncidentDraft = vi.fn();
const mockRunIncidentTeeth = vi.fn();
const mockRunIncidentApprove = vi.fn();
vi.mock("@stele/cli", () => ({
  runIncidentDraft: mockRunIncidentDraft,
  runIncidentTeeth: mockRunIncidentTeeth,
  runIncidentApprove: mockRunIncidentApprove,
}));

const mockValidateProjectDir = vi.fn();
vi.mock("../../src/path-validation.js", () => ({ validateProjectDir: mockValidateProjectDir }));

const { createIncidentDraftTool } = await import("../../src/tools/incident-draft.js");

const OK_DRAFT = {
  proposedInvariantBlock: "(invariant no-double-charge (severity error) (assert true))",
  dryRun: { ok: true as const },
  id: "no-double-charge",
  fixSha: "a".repeat(40),
  parentSha: "b".repeat(40),
  draftPath: "/project/.stele/incident/no-double-charge/draft.json",
};

describe("incident_draft tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct tool metadata", () => {
    const tool = createIncidentDraftTool();
    expect(tool.name).toBe("incident_draft");
    expect(tool.inputSchema).toBeDefined();
    expect(Object.keys(tool.inputSchema as object).length).toBeGreaterThan(0);
    expect((tool.inputSchema as { required: string[] }).required).toEqual([
      "intent",
      "fix",
      "draftFrom",
    ]);
  });

  it("calls runIncidentDraft once with mapped args and serializes the result verbatim", async () => {
    const tool = createIncidentDraftTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentDraft.mockResolvedValue(OK_DRAFT);

    const result = await tool.handler({
      projectDir: "/project",
      intent: "Payments must not double-charge",
      fix: "HEAD",
      draftFrom: "/tmp/draft.json",
      id: "no-double-charge",
    });

    expect(mockRunIncidentDraft).toHaveBeenCalledTimes(1);
    expect(mockRunIncidentDraft).toHaveBeenCalledWith("/project", {
      intent: "Payments must not double-charge",
      fix: "HEAD",
      draftFrom: "/tmp/draft.json",
      id: "no-double-charge",
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain(OK_DRAFT.proposedInvariantBlock);
    expect(result.content[0].text).toContain(OK_DRAFT.fixSha);
    expect(result.content[0].text).toContain(OK_DRAFT.draftPath);
  });

  it("forwards id as undefined when omitted", async () => {
    const tool = createIncidentDraftTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentDraft.mockResolvedValue(OK_DRAFT);

    await tool.handler({
      projectDir: "/project",
      intent: "x",
      fix: "HEAD",
      draftFrom: "/tmp/draft.json",
    });

    expect(mockRunIncidentDraft).toHaveBeenCalledWith("/project", {
      intent: "x",
      fix: "HEAD",
      draftFrom: "/tmp/draft.json",
      id: undefined,
    });
  });

  it("maps dryRun.ok=false to isError:true surfacing the message", async () => {
    const tool = createIncidentDraftTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentDraft.mockResolvedValue({
      ...OK_DRAFT,
      dryRun: { ok: false, message: "invariantCdl failed to compile: unexpected token" },
    });

    const result = await tool.handler({
      projectDir: "/project",
      intent: "x",
      fix: "HEAD",
      draftFrom: "/tmp/draft.json",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to compile");
  });

  it("short-circuits on validateProjectDir error before any lib call", async () => {
    const tool = createIncidentDraftTool();
    mockValidateProjectDir.mockReturnValue({ error: "Path does not exist" });

    const result = await tool.handler({
      projectDir: "/nope",
      intent: "x",
      fix: "HEAD",
      draftFrom: "/tmp/draft.json",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path does not exist");
    expect(mockRunIncidentDraft).not.toHaveBeenCalled();
  });

  it("maps a rejected lib promise to isError:true via sanitizeError", async () => {
    const tool = createIncidentDraftTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentDraft.mockRejectedValueOnce(new Error("git not available"));

    const result = await tool.handler({
      projectDir: "/project",
      intent: "x",
      fix: "HEAD",
      draftFrom: "/tmp/draft.json",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unable to draft incident");
  });
});
