import { createHash } from "node:crypto";

import { commandName } from "@stele/core";
import type { Command } from "commander";

import { ExitCode } from "../../errors.js";
import { listProvenanceIds, readProvenance } from "./provenance.js";
import { validateIncidentId } from "./shared.js";
import {
  type ResolvedToolchain,
  type TeethRunner,
  assertSafeTestBasename,
  resolveTeethRunner,
} from "./teeth-runners.js";
import { deriveTeethVerdict, runCandidateInWorktrees } from "./teeth.js";

export type IncidentReverifyOptions = { id?: string; all?: boolean };

type Outcome =
  | { kind: "reproduced"; detail: string }
  | { kind: "contradicted"; detail: string }
  | { kind: "infra"; detail: string };

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Re-derive ONE incident's teeth verdict from git + its committed provenance
 * record, independent of the original run. Three outcomes:
 *  - reproduced: the worktrees ran and re-derived the recorded verdict.
 *  - contradicted: the worktrees ran but disagree (record tampered, or the proof
 *    no longer holds on the current toolchain) — a real integrity failure.
 *  - infra: could NOT re-run (missing/malformed record, absent toolchain, a SHA
 *    not present in this clone, worktree failure). NOT a false-red; distinct exit.
 */
async function reverifyOne(
  projectDir: string,
  id: string,
  deps: { python?: string },
): Promise<Outcome> {
  let record;
  try {
    record = await readProvenance(projectDir, id);
  } catch (error) {
    return { kind: "infra", detail: `cannot read provenance: ${(error as Error).message}` };
  }

  // Record self-consistency: the embedded test/invariant must hash to the
  // recorded hashes. A mismatch means the committed record was edited — a
  // contradiction, not an infra problem.
  if (sha256Hex(record.negativeTest) !== record.testSha256) {
    return { kind: "contradicted", detail: "recorded negativeTest does not match recorded testSha256" };
  }
  if (sha256Hex(record.invariantCdl) !== record.invariantSha256) {
    return { kind: "contradicted", detail: "recorded invariantCdl does not match recorded invariantSha256" };
  }

  let runner: TeethRunner;
  let toolchain: ResolvedToolchain;
  let parentRun;
  let fixRun;
  try {
    const testBasename = assertSafeTestBasename(record.testFilename);
    runner = resolveTeethRunner(testBasename);
    toolchain = runner.locate(projectDir, runner.language === "python" ? deps.python : undefined);
    ({ parentRun, fixRun } = runCandidateInWorktrees(projectDir, {
      tmpLabel: `reverify-${id}`,
      parentSha: record.parentSha,
      fixSha: record.fixSha,
      testBasename,
      testBytes: Buffer.from(record.negativeTest, "utf8"),
      runner,
      toolchain,
    }));
  } catch (error) {
    return { kind: "infra", detail: `could not re-run: ${(error as Error).message}` };
  }

  const { verdict } = deriveTeethVerdict(parentRun, fixRun, runner);
  if (verdict === record.verdict) {
    return { kind: "reproduced", detail: `re-derived ${verdict}` };
  }
  return {
    kind: "contradicted",
    detail: `recorded ${record.verdict}, re-derived ${verdict} (parent exit=${parentRun.exit}, fix exit=${fixRun.exit})`,
  };
}

/**
 * `stele incident reverify --id <id> | --all`. Exit codes: 0 all reproduced,
 * 2 (CONTRACT_FAIL) any contradicted, 1 (USER_ERROR) any infra-only failure.
 */
export async function runIncidentReverify(
  projectDir: string,
  options: IncidentReverifyOptions,
  deps: { stdout?: NodeJS.WritableStream; python?: string } = {},
): Promise<void> {
  const out = deps.stdout ?? process.stdout;

  let ids: string[];
  if (options.all) {
    ids = await listProvenanceIds(projectDir);
  } else if (options.id !== undefined) {
    try {
      ids = [validateIncidentId(options.id)];
    } catch (error) {
      out.write(`error: ${(error as Error).message}\n`);
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
  } else {
    out.write("error: reverify requires --id <id> or --all.\n");
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }

  if (ids.length === 0) {
    out.write("No incident provenance records found (contract/provenance/).\n");
    return;
  }

  let anyContradicted = false;
  let anyInfra = false;
  for (const id of ids) {
    const outcome = await reverifyOne(projectDir, id, deps);
    const label =
      outcome.kind === "reproduced" ? "OK     " : outcome.kind === "contradicted" ? "CONTRA " : "INFRA  ";
    out.write(`${label} ${id}: ${outcome.detail}\n`);
    if (outcome.kind === "contradicted") anyContradicted = true;
    if (outcome.kind === "infra") anyInfra = true;
  }

  if (anyContradicted) {
    process.exitCode = ExitCode.CONTRACT_FAIL;
  } else if (anyInfra) {
    process.exitCode = ExitCode.USER_ERROR;
  }
}

/** Attach the `reverify` subcommand to the shared `incident` parent. */
export function registerIncidentReverify(incident: Command): void {
  incident
    .command(commandName("reverify"))
    .description(
      "Re-derive locked incident teeth verdicts from git + committed provenance. Exit 0 reproduced, 2 contradicted, 1 could-not-reproduce.",
    )
    .option("--id <id>", "reverify a single incident")
    .option("--all", "reverify every incident with a committed provenance record")
    .action(async (opts: { id?: string; all?: boolean }) => {
      await runIncidentReverify(process.cwd(), { id: opts.id, all: opts.all });
    });
}
