import { describe, expect, it } from "vitest";

import type { CliResult } from "../src/cli-runner.js";
import { runReverify } from "../src/modes/reverify.js";

function harness(result: Partial<CliResult>) {
  const calls = { failed: [] as string[], warned: [] as string[], info: [] as string[], args: [] as string[][] };
  const deps = {
    spawn: async (args: string[]): Promise<CliResult> => {
      calls.args.push(args);
      return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    setFailed: (m: string) => calls.failed.push(m),
    warning: (m: string) => calls.warned.push(m),
    info: (m: string) => calls.info.push(m),
  };
  return { deps, calls };
}

describe("runReverify (github-action mode)", () => {
  it("runs `incident reverify --all`", async () => {
    const { deps, calls } = harness({ exitCode: 0 });
    await runReverify(deps);
    expect(calls.args[0]).toEqual(["incident", "reverify", "--all"]);
  });

  it("exit 0 → pass (no failure, no warning)", async () => {
    const { deps, calls } = harness({ exitCode: 0, stdout: "OK x: re-derived TEETH_PROVEN" });
    await runReverify(deps);
    expect(calls.failed).toHaveLength(0);
    expect(calls.warned).toHaveLength(0);
  });

  it("exit 2 (contradicted) → setFailed", async () => {
    const { deps, calls } = harness({ exitCode: 2, stdout: "CONTRA x: recorded TEETH_PROVEN, re-derived TEETH_FAILED" });
    await runReverify(deps);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]).toMatch(/CONTRADICTED/);
    expect(calls.warned).toHaveLength(0);
  });

  it("exit 1 (could-not-reproduce) → warning, NOT failure", async () => {
    const { deps, calls } = harness({ exitCode: 1, stdout: "INFRA x: could not re-run" });
    await runReverify(deps);
    expect(calls.failed).toHaveLength(0);
    expect(calls.warned).toHaveLength(1);
    expect(calls.warned[0]).toMatch(/could not re-run/i);
  });

  it("unexpected exit → setFailed with the code", async () => {
    const { deps, calls } = harness({ exitCode: 5, stderr: "boom" });
    await runReverify(deps);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]).toMatch(/exited 5/);
  });
});
