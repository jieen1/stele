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

const { createIncidentTeethTool } = await import("../../src/tools/incident-teeth.js");

const PROVEN = {
  verdict: "TEETH_PROVEN" as const,
  parentRun: { exit: 1, outputSha256: "p".repeat(64) },
  fixRun: { exit: 0, outputSha256: "f".repeat(64) },
  testSha256: "t".repeat(64),
  teethPath: "/project/.stele/proofs/inc/teeth.json",
};

describe("incident_teeth tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns correct tool metadata", () => {
    const tool = createIncidentTeethTool();
    expect(tool.name).toBe("incident_teeth");
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["id"]);
  });

  it("calls runIncidentTeeth once with mapped args", async () => {
    const tool = createIncidentTeethTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentTeeth.mockResolvedValue(PROVEN);

    await tool.handler({ projectDir: "/project", id: "inc", runLocal: true });

    expect(mockRunIncidentTeeth).toHaveBeenCalledTimes(1);
    expect(mockRunIncidentTeeth).toHaveBeenCalledWith("/project", { id: "inc", runLocal: true });
  });

  it("TEETH_PROVEN -> isError:false with verdict + testSha256 + runs in content", async () => {
    const tool = createIncidentTeethTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentTeeth.mockResolvedValue(PROVEN);

    const result = await tool.handler({ projectDir: "/project", id: "inc" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("TEETH_PROVEN");
    expect(result.content[0].text).toContain(PROVEN.testSha256);
    expect(result.content[0].text).toContain(PROVEN.parentRun.outputSha256);
    expect(result.content[0].text).toContain(PROVEN.fixRun.outputSha256);
    expect(result.content[0].text).toContain("exit=1");
    expect(result.content[0].text).toContain("exit=0");
  });

  it("TEETH_FAILED -> ALSO isError:false (negative verdict is a successful run)", async () => {
    const tool = createIncidentTeethTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentTeeth.mockResolvedValue({
      ...PROVEN,
      verdict: "TEETH_FAILED",
      parentRun: { exit: 0, outputSha256: "p".repeat(64) },
    });

    const result = await tool.handler({ projectDir: "/project", id: "inc" });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("TEETH_FAILED");
  });

  it("infra error (rejected promise) -> isError:true via sanitizeError", async () => {
    const tool = createIncidentTeethTool();
    mockValidateProjectDir.mockReturnValue({ path: "/project" });
    mockRunIncidentTeeth.mockRejectedValueOnce(new Error("No incident draft for id"));

    const result = await tool.handler({ projectDir: "/project", id: "inc" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unable to run teeth proof");
  });

  it("short-circuits on validateProjectDir error before any lib call", async () => {
    const tool = createIncidentTeethTool();
    mockValidateProjectDir.mockReturnValue({ error: "Symlinks are not allowed for projectDir" });

    const result = await tool.handler({ projectDir: "/sym", id: "inc" });

    expect(result.isError).toBe(true);
    expect(mockRunIncidentTeeth).not.toHaveBeenCalled();
  });
});
