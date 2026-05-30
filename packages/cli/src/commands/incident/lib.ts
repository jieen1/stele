import { Writable } from "node:stream";

import { getExitCode, isCliCommandError } from "../../errors.js";
import { runIncidentApprove as runIncidentApproveVoid } from "./approve.js";
import { runIncidentDraft as runIncidentDraftVoid } from "./draft.js";
import { runIncidentTeeth as runIncidentTeethVoid } from "./teeth.js";
import {
  draftJsonPath,
  readDraftJson,
  readTeeth,
  teethJsonPath,
} from "./shared.js";

import type { IncidentApproveOptions } from "./approve.js";
import type { IncidentDraftOptions } from "./draft.js";
import type { IncidentTeethOptions } from "./teeth.js";

/**
 * Result-returning orchestrators that wrap the CLI-coupled (void + stdout +
 * process.exitCode / throw) incident run* functions into typed results the MCP
 * tools (and any non-CLI caller) can serialize.
 *
 * These adapters NEVER call process.exit and NEVER write to the shared
 * process.stdout: they inject a capturing Writable for the run* `deps.stdout`
 * seam and, for the two run* fns that signal failure via process.exitCode rather
 * than a throw (draft, teeth), they save/clear/restore process.exitCode locally
 * so a long-running host (the stdio MCP server) is never poisoned. The CLI layer
 * keeps owning real stdout + exit codes; this layer owns the typed result.
 *
 * Determinism is unchanged: these add ZERO new IO over the void fns — same git,
 * same scratch paths, same teeth.json producedAtFromGit (fix committer date),
 * same atomic apply→generate→lock-with-rollback inside approve. No timestamp is
 * injected here.
 */

export type IncidentDraftResult = {
  proposedInvariantBlock: string;
  dryRun: { ok: boolean; message?: string };
  id: string;
  fixSha: string;
  parentSha: string;
  draftPath: string;
};

export type IncidentTeethRunResult = { exit: number; outputSha256: string };

export type IncidentTeethResult = {
  verdict: "TEETH_PROVEN" | "TEETH_FAILED";
  parentRun: IncidentTeethRunResult;
  fixRun: IncidentTeethRunResult;
  testSha256: string;
  teethPath: string;
};

export type IncidentApproveResult = {
  approved: boolean;
  refused?: boolean;
  reason?: string;
  tagsApplied: string[];
  approvalRecordPath: string;
  checkExitCode: number;
};

/** A Writable that accumulates all written chunks as a UTF-8 string. */
class CaptureStream extends Writable {
  private chunks: Buffer[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    callback();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Run a void incident fn whose failure path sets process.exitCode (and writes to
 * stderr) WITHOUT throwing. We snapshot process.exitCode, clear it, run, read the
 * post-run value, and always restore the snapshot — so the host process's own
 * exit status is never mutated. Returns { ok, captured } where ok === the fn left
 * exitCode unset/zero.
 */
async function runExitCodeFn(
  fn: (capture: CaptureStream) => Promise<void>,
): Promise<{ ok: boolean; captured: string }> {
  const capture = new CaptureStream();
  const prior = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn(capture);
    const code = process.exitCode;
    return { ok: code === undefined || code === 0, captured: capture.text() };
  } finally {
    process.exitCode = prior;
  }
}

/**
 * Extract the proposed `(invariant ...)` block from the draft fn's captured
 * stdout. On success the void draft fn prints the block between a header line and
 * the first blank line; fall back to the whole capture if the markers move.
 */
function extractInvariantBlock(captured: string): string {
  const lines = captured.split("\n");
  const headerIdx = lines.findIndex((l) => l.includes("Proposed invariant"));
  if (headerIdx === -1) return captured.trim();
  const start = headerIdx + 1;
  let i = start;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  const blockStart = i;
  while (i < lines.length && lines[i].trim().length > 0) i++;
  const block = lines.slice(blockStart, i).join("\n").trim();
  return block.length > 0 ? block : captured.trim();
}

/**
 * runIncidentDraft (result-returning). Resolves the id the same way the void fn
 * does (explicit --id, else slug from intent) so the returned draftPath matches
 * what was written. dryRun.ok=false carries the failure message; the scratch dir
 * is only written on success (the void fn validates before any write).
 */
export async function runIncidentDraft(
  projectDir: string,
  options: IncidentDraftOptions,
): Promise<IncidentDraftResult> {
  const { ok, captured } = await runExitCodeFn((capture) =>
    runIncidentDraftVoid(projectDir, options, { stdout: capture }),
  );

  if (!ok) {
    return {
      proposedInvariantBlock: "",
      dryRun: { ok: false, message: captured.trim() || "draft failed" },
      id: options.id ?? "",
      fixSha: "",
      parentSha: "",
      draftPath: "",
    };
  }

  // On success the draft.json now exists; read it back for the authoritative
  // id/shas rather than re-deriving the slug here.
  const draft = await readDraftJson(projectDir, requireResolvedId(projectDir, options, captured));
  const id = resolvedIdFromCapture(captured) ?? options.id ?? "";
  return {
    proposedInvariantBlock: extractInvariantBlock(captured),
    dryRun: { ok: true },
    id,
    fixSha: draft.fixSha,
    parentSha: draft.parentSha,
    draftPath: draftJsonPath(projectDir, id),
  };
}

/** Parse the `incident id:   <id>` line the void draft fn prints on success. */
function resolvedIdFromCapture(captured: string): string | undefined {
  const m = captured.match(/incident id:\s+(\S+)/);
  return m ? m[1] : undefined;
}

function requireResolvedId(
  projectDir: string,
  options: IncidentDraftOptions,
  captured: string,
): string {
  const id = resolvedIdFromCapture(captured) ?? options.id;
  if (id === undefined || id.length === 0) {
    throw new Error("Could not resolve incident id from a successful draft run.");
  }
  return id;
}

/**
 * runIncidentTeeth (result-returning). The void fn writes teeth.json on a
 * successful run (PROVEN or FAILED) and only sets process.exitCode on an INFRA
 * error; we therefore treat !ok (or an absent/unwritten proof) as an infra
 * failure and throw, and read the verdict from the freshly-written teeth.json.
 */
export async function runIncidentTeeth(
  projectDir: string,
  options: IncidentTeethOptions,
): Promise<IncidentTeethResult> {
  const { ok, captured } = await runExitCodeFn((capture) =>
    runIncidentTeethVoid(projectDir, options, { stdout: capture }),
  );

  if (!ok) {
    throw new Error(captured.trim() || "teeth run failed (infrastructure error)");
  }

  const proof = await readTeeth(projectDir, options.id);
  if (proof === null) {
    throw new Error("teeth run completed but no teeth.json was written.");
  }
  if (proof.verdict === "TEETH_UNAVAILABLE") {
    // teeth itself never writes TEETH_UNAVAILABLE; if seen, it is a corrupt proof.
    throw new Error("teeth.json has an unexpected TEETH_UNAVAILABLE verdict.");
  }

  return {
    verdict: proof.verdict,
    parentRun: { exit: proof.parentRun.exit, outputSha256: proof.parentRun.outputSha256 },
    fixRun: { exit: proof.fixRun.exit, outputSha256: proof.fixRun.outputSha256 },
    testSha256: proof.testSha256,
    teethPath: teethJsonPath(projectDir, options.id),
  };
}

const PROVENANCE_TAG = "provenance:incident";
const TEETH_UNPROVEN_TAG = "teeth:unproven";

/**
 * runIncidentApprove (result-returning). The void fn throws CliCommandError on
 * any refusal/failure and returns void on success (repo left at stele-check
 * exit-0 by its atomic apply→generate→lock). We map:
 *   - success  -> { approved:true, tagsApplied, approvalRecordPath, checkExitCode:0 }
 *   - CliCommandError(USER_ERROR) -> { approved:false, refused:true, reason }
 *     (NO numeric exit-code field exposed beyond checkExitCode — C4: no new code)
 *   - any other throw is re-thrown (infra error -> the MCP catch sanitizes it).
 *
 * tagsApplied mirrors approve.ts: ['provenance:incident'] always, plus
 * 'teeth:unproven' when a --teeth-unavailable-reason was supplied. The approval
 * record path is parsed from the void fn's captured stdout.
 */
export async function runIncidentApprove(
  projectDir: string,
  options: IncidentApproveOptions,
): Promise<IncidentApproveResult> {
  const capture = new CaptureStream();
  try {
    await runIncidentApproveVoid(projectDir, options, { stdout: capture });
  } catch (error) {
    if (isCliCommandError(error) && getExitCode(error) === 1) {
      return {
        approved: false,
        refused: true,
        reason: error.message,
        tagsApplied: [],
        approvalRecordPath: "",
        checkExitCode: 1,
      };
    }
    throw error;
  }

  const captured = capture.text();
  const tagsApplied = options.teethUnavailableReason
    ? [PROVENANCE_TAG, TEETH_UNPROVEN_TAG]
    : [PROVENANCE_TAG];
  const approvalMatch = captured.match(/approval\s+(\S+)/);
  return {
    approved: true,
    tagsApplied,
    approvalRecordPath: approvalMatch ? approvalMatch[1] : "",
    checkExitCode: 0,
  };
}
