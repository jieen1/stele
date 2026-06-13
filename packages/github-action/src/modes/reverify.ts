import * as core from "@actions/core";
import { spawnCli, type CliResult } from "../cli-runner.js";

export interface RunReverifyDeps {
  spawn?: (args: string[]) => Promise<CliResult>;
  setFailed?: (message: string) => void;
  warning?: (message: string) => void;
  info?: (message: string) => void;
}

/**
 * `mode: reverify` — re-derive every locked incident teeth verdict from git +
 * the committed provenance records, read-only. Maps `stele incident reverify
 * --all` exit codes to CI outcomes:
 *   0 — all reproduced → pass.
 *   2 — a verdict was CONTRADICTED (tamper, or the proof no longer holds) →
 *       setFailed (the integrity failure CI exists to catch).
 *   1 — could-not-reproduce (an absent SHA / toolchain) → a WARNING, never a
 *       failure: it is not a tamper, and failing CI on it would be a false alarm.
 */
export async function runReverify(deps: RunReverifyDeps = {}): Promise<void> {
  const spawn = deps.spawn ?? ((args) => spawnCli(args));
  const setFailed = deps.setFailed ?? ((message: string) => core.setFailed(message));
  const warning = deps.warning ?? ((message: string) => core.warning(message));
  const info = deps.info ?? ((message: string) => core.info(message));

  const result = await spawn(["incident", "reverify", "--all"]);
  const detail = (result.stdout || result.stderr).trim();
  if (detail.length > 0) {
    info(detail);
  }

  switch (result.exitCode) {
    case 0:
      info("All locked incident teeth verdicts reproduced from git.");
      return;
    case 2:
      setFailed(
        "Incident provenance reverify CONTRADICTED a locked verdict — the proof no longer holds or the record was tampered. Inspect the offending incident(s) above.",
      );
      return;
    case 1:
      warning(
        "Incident provenance reverify could not re-run one or more proofs (absent SHA / toolchain). Not treated as a failure — re-run where the toolchain + history are present.",
      );
      return;
    default:
      setFailed(
        `stele incident reverify exited ${result.exitCode}: ${result.stderr.trim() || "no output"}`,
      );
  }
}
