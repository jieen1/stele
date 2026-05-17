import { describe, expect, it, vi } from "vitest";
import { spawnCli, type CliResult, type CliRunnerOptions } from "../src/cli-runner.js";

describe("spawnCli", () => {
  function makeSpawnMock(status: number, stdout = "", stderr = "") {
    return vi.fn(() => ({ status, stdout, stderr }));
  }

  it("returns CliResult on success", async () => {
    const mockSpawn = makeSpawnMock(0, "0.1.0", "");
    const result = await spawnCli(["check"], { spawn: mockSpawn });
    expect(result.exitCode).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(2); // version check + actual command
  });

  it("throws when version check fails", async () => {
    const mockSpawn = makeSpawnMock(1, "", "not found");
    await expect(spawnCli(["check"], { spawn: mockSpawn })).rejects.toThrow("Stele CLI not found");
  });

  it("captures stdout and stderr", async () => {
    const mockSpawn = makeSpawnMock(0, "0.1.0", "");
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "0.1.0", stderr: "" });
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "output", stderr: "warn" });
    const result = await spawnCli(["check"], { spawn: mockSpawn });
    expect(result.stdout).toBe("output");
    expect(result.stderr).toBe("warn");
    expect(result.exitCode).toBe(0);
  });

  it("passes args to spawn", async () => {
    const mockSpawn = makeSpawnMock(0, "0.1.0", "");
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "0.1.0", stderr: "" });
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    await spawnCli(["generate", "--force"], { spawn: mockSpawn });
    const secondCall = mockSpawn.mock.calls[1];
    expect(secondCall[1]).toEqual(["stele", "generate", "--force"]);
  });
});
