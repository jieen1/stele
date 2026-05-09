import * as core from "@actions/core";
import { spawnCli, type CliResult } from "../cli-runner.js";

export interface RunGenerateDeps {
  spawn?: (args: string[]) => Promise<CliResult>;
  setFailed?: (message: string) => void;
  log?: (message: string) => void;
}

/**
 * Run `stele generate` and surface drift via the action's exit status.
 * Exit code 2 from the CLI means the generated artifacts diverged from the
 * CDL — i.e., the user forgot to commit a fresh `stele generate` run.
 */
export async function runGenerate(deps: RunGenerateDeps = {}): Promise<void> {
  const spawn = deps.spawn ?? ((args) => spawnCli(args));
  const setFailed = deps.setFailed ?? ((message: string) => core.setFailed(message));
  const log = deps.log ?? ((message: string) => core.info(message));

  const result = await spawn(["generate"]);

  if (result.exitCode === 0) {
    log("stele generate produced no drift.");
    if (result.stdout.trim().length > 0) {
      log(result.stdout.trim());
    }
    return;
  }

  if (result.exitCode === 2) {
    setFailed(
      "Generated test files drifted from CDL. Run `stele generate` locally and commit the changes.",
    );
    return;
  }

  setFailed(
    `stele generate failed (exit ${result.exitCode}): ${result.stderr.trim() || "no output"}`,
  );
}
