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

const { createIncidentApproveTool } = await import("../../src/tools/incident-approve.js");

describe("incident_approve tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct tool metadata", () => {
    const tool = createIncidentApproveTool();
    expect(tool.name).toBe("incident_approve");
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["id"]);
  });

  it("success -> isError:false naming the provenance tag + approval record + check exit-0", async () => {
    const tool = createIncidentApproveTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentApprove.mockResolvedValue({
      approved: true,
      tagsApplied: ["provenance:incident"],
      approvalRecordPath: "/project/.stele/incident/inc/approval-x.json",
      checkExitCode: 0,
    });

    const result = await tool.handler({ projectDir: "/project", id: "inc" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("provenance:incident");
    expect(result.content[0].text).toContain("/project/.stele/incident/inc/approval-x.json");
    expect(result.content[0].text).toContain("exit-0");
  });

  it("refused -> isError:true with reason and NO numeric exit-code field on the result", async () => {
    const tool = createIncidentApproveTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentApprove.mockResolvedValue({
      approved: false,
      refused: true,
      reason: "Teeth proof verdict is TEETH_FAILED",
      tagsApplied: [],
      approvalRecordPath: "",
      checkExitCode: 1,
    });

    const result = await tool.handler({ projectDir: "/project", id: "inc" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TEETH_FAILED");
    // C4: McpResult exposes only content + isError, never an invented exit code.
    expect(Object.keys(result)).toEqual(expect.arrayContaining(["content", "isError"]));
    expect(result).not.toHaveProperty("exitCode");
    expect(result).not.toHaveProperty("code");
  });

  it("forwards teethUnavailableReason unchanged and surfaces teeth:unproven tag", async () => {
    const tool = createIncidentApproveTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentApprove.mockResolvedValue({
      approved: true,
      tagsApplied: ["provenance:incident", "teeth:unproven"],
      approvalRecordPath: "/project/.stele/incident/inc/approval-x.json",
      checkExitCode: 0,
    });

    const result = await tool.handler({
      projectDir: "/project",
      id: "inc",
      approvedBy: "alice@example.com",
      teethUnavailableReason: "pytest unavailable in CI sandbox",
    });

    expect(mockRunIncidentApprove).toHaveBeenCalledTimes(1);
    expect(mockRunIncidentApprove).toHaveBeenCalledWith("/project", {
      id: "inc",
      approvedBy: "alice@example.com",
      teethUnavailableReason: "pytest unavailable in CI sandbox",
    });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("teeth:unproven");
  });

  it("infra error (rejected promise) -> isError:true via sanitizeError", async () => {
    const tool = createIncidentApproveTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentApprove.mockRejectedValueOnce(new Error("loadConfig failed"));

    const result = await tool.handler({ projectDir: "/project", id: "inc" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unable to approve incident");
  });

  it("short-circuits on validateProjectDir error before any lib call", async () => {
    const tool = createIncidentApproveTool();
    mockValidateProjectDir.mockReturnValue({ error: "projectDir must be a non-empty string" });

    const result = await tool.handler({ id: "inc" });

    expect(result.isError).toBe(true);
    expect(mockRunIncidentApprove).not.toHaveBeenCalled();
  });
});
