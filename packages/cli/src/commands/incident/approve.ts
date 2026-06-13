import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { commandName, parseFile } from "@stele/core";
import type { Command } from "commander";

import { loadConfig } from "../../config/loadConfig.js";
import { CliCommandError, ExitCode, getExitCode } from "../../errors.js";
import { isMissingFileError, readOptionalFile } from "../../utils/shared-utils.js";
import {
  attachApprovedBy,
  draftApproval,
  signApproval,
  writeSignedApproval,
  type ApprovalPayload,
} from "../design/approval-lifecycle.js";
import {
  type ProvenanceRecord,
  provenancePath,
  writeProvenance,
} from "./provenance.js";
import { resolveApprovedBy } from "../design/approve.js";
import { runGenerate } from "../generate.js";
import { runLock } from "../lock.js";
import { runPropose } from "../propose.js";
import {
  incidentScratchDir,
  readDraft,
  readTeeth,
  validateIncidentId,
  type IncidentDraft,
  type TeethProof,
} from "./shared.js";
import {
  bindTeethProof,
  draftProvenDraft,
  markTeethProven,
  type ProvenDraft,
} from "./incident-lifecycle.js";

// runPropose's append targets (mirrored from propose.ts). runPropose self-rolls-
// back only THIS append; generate writes the tests dir and lock writes the
// manifest, so the OUTER snapshot below must also cover those.
const PROPOSAL_FILE = "contract/proposals/agent-additions.stele";

const PROVENANCE_TAG = "provenance:incident";
const TEETH_UNPROVEN_TAG = "teeth:unproven";

export type IncidentApproveOptions = {
  id: string;
  approvedBy?: string;
  teethUnavailableReason?: string;
};

/**
 * The scalar fields approve hands to runPropose. These are extracted TEXTUALLY
 * from the draft's invariantCdl (which the draft step already proved compiles,
 * and which we re-parse below as a dry-run gate). We do NOT read fields off the
 * `parseFile` AST: `parseFile` returns only `{ body: AstNode[] }` (a raw parse,
 * no validated InvariantDeclaration), so the validated scalar fields exist only
 * after the full validator runs — which happens inside runPropose's loadContract.
 * Extracting the human-authored text also preserves the assert expression
 * byte-for-byte rather than re-serialising an AST core has no printer for.
 */
export type ParsedInvariant = {
  id: string;
  severity: string;
  description: string;
  category?: string;
  rationale?: string;
  assert: string;
};

/**
 * Extract the inner body of the FIRST balanced `(<op> ...)` form in `cdl`,
 * scanning paren depth from the opening paren of the marker. Returns the text
 * between the operator name and its matching `)`, trimmed; `null` when the
 * marker is absent or unbalanced.
 */
function extractFormBody(cdl: string, op: string): string | null {
  const marker = `(${op}`;
  const start = cdl.indexOf(marker);
  if (start === -1) return null;
  // The char after the op name must be whitespace / paren so `(assert` does not
  // match `(assertion`.
  const after = cdl[start + marker.length];
  if (
    after !== undefined &&
    after !== " " &&
    after !== "\n" &&
    after !== "\t" &&
    after !== "\r" &&
    after !== ")" &&
    after !== "("
  ) {
    return null;
  }
  let depth = 0;
  let i = start;
  let inString = false;
  for (; i < cdl.length; i++) {
    const ch = cdl[i];
    if (inString) {
      // Inside a CDL string literal, parens are DATA, not structure. Skip a
      // backslash-escaped char (e.g. \" or \\) so an escaped quote does not
      // prematurely close the string. This is what makes the extractor string-
      // literal-aware: a ')' inside `"...)..."` no longer mis-terminates the
      // form, so a description/rationale/assert containing ')' extracts correctly.
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return cdl.slice(start + marker.length, i).trim();
}

/** Read a quoted-string field value, e.g. `(description "x")` -> `x`. */
function extractStringField(cdl: string, op: string): string | undefined {
  const body = extractFormBody(cdl, op);
  if (body === null || body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "string") return parsed;
  } catch {
    // Bare atom (e.g. category): fall through and return as-is.
  }
  return body;
}

function parseInvariantFromDraft(draft: IncidentDraft): ParsedInvariant {
  // Dry-run compile gate — re-prove the draft still parses against this build.
  try {
    parseFile(draft.invariantCdl, "incident/invariant.stele");
  } catch (error) {
    throw new CliCommandError(
      `Draft invariantCdl no longer compiles: ${(error as Error).message}`,
      ExitCode.USER_ERROR,
    );
  }

  const invariantBody = extractFormBody(draft.invariantCdl, "invariant");
  if (invariantBody === null) {
    throw new CliCommandError(
      "Draft invariantCdl contains no (invariant ...) form.",
      ExitCode.USER_ERROR,
    );
  }
  // The id is the first token after `(invariant`.
  const idMatch = invariantBody.match(/^([A-Za-z_][A-Za-z0-9_-]*)/);
  if (idMatch === null) {
    throw new CliCommandError(
      "Draft invariantCdl (invariant ...) has no parseable id.",
      ExitCode.USER_ERROR,
    );
  }
  const assert = extractFormBody(draft.invariantCdl, "assert");
  if (assert === null || assert.length === 0) {
    throw new CliCommandError(
      "Draft invariantCdl has no (assert ...) expression.",
      ExitCode.USER_ERROR,
    );
  }
  return {
    id: idMatch[1],
    severity: extractStringField(draft.invariantCdl, "severity") ?? "error",
    description:
      extractStringField(draft.invariantCdl, "description") ?? `Incident ${draft.intent}`,
    category: extractStringField(draft.invariantCdl, "category"),
    rationale: extractStringField(draft.invariantCdl, "rationale"),
    assert,
  };
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Bind the (TEETH_PROVEN) proof to the EXACT draft approve is about to lock. The
 * proof is tamper-EVIDENT (it records parentSha, fixSha, and the sha256 of the
 * candidate-test bytes) but both .stele/incident/<id>/ and .stele/proofs/<id>/
 * are editable scratch — so without this check an attacker could prove teeth on a
 * genuine bug/fix pair, then swap a weaker invariant / different test / repointed
 * fixSha into draft.json and have approve lock the EDITED draft under the stale
 * TEETH_PROVEN verdict. We therefore require the proof's parentSha/fixSha to equal
 * the draft's, recompute the sha256 of the current candidate-test bytes and require
 * it to equal teeth.testSha256, AND recompute the sha256 of the current invariant
 * CDL and require it to equal teeth.invariantSha256. The invariant hash closes the
 * "prove teeth on a strict invariant, then swap in a vacuous one (same test bytes)"
 * hole — the proof attests to BOTH the test and the invariant it was produced for.
 * Any mismatch means the draft changed since the proof was produced; refuse and
 * instruct the user to re-run teeth.
 */
async function enforceTeethBinding(
  projectDir: string,
  id: string,
  teeth: TeethProof,
  draft: IncidentDraft,
): Promise<void> {
  if (teeth.parentSha !== draft.parentSha) {
    throw new CliCommandError(
      `Teeth proof parentSha (${teeth.parentSha}) does not match draft parentSha (${draft.parentSha}). ` +
        "The draft changed since the proof was produced. Re-run `stele incident teeth`.",
      ExitCode.USER_ERROR,
    );
  }
  if (teeth.fixSha !== draft.fixSha) {
    throw new CliCommandError(
      `Teeth proof fixSha (${teeth.fixSha}) does not match draft fixSha (${draft.fixSha}). ` +
        "The draft changed since the proof was produced. Re-run `stele incident teeth`.",
      ExitCode.USER_ERROR,
    );
  }
  const candidateTestPath = join(
    incidentScratchDir(projectDir, id),
    basename(draft.testFilename),
  );
  let testBytes: Buffer;
  try {
    testBytes = await readFile(candidateTestPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new CliCommandError(
        `Candidate test ${candidateTestPath} is missing; cannot verify the teeth proof binding. ` +
          "Re-run `stele incident draft` then `stele incident teeth`.",
        ExitCode.USER_ERROR,
      );
    }
    throw error;
  }
  const actual = sha256Hex(testBytes);
  if (actual !== teeth.testSha256) {
    throw new CliCommandError(
      `Candidate-test sha256 (${actual}) does not match the teeth proof testSha256 (${teeth.testSha256}). ` +
        "The negative test changed since the proof was produced. Re-run `stele incident teeth`.",
      ExitCode.USER_ERROR,
    );
  }
  const actualInvariant = sha256Hex(draft.invariantCdl);
  if (actualInvariant !== teeth.invariantSha256) {
    throw new CliCommandError(
      `Invariant sha256 (${actualInvariant}) does not match the teeth proof invariantSha256 (${teeth.invariantSha256}). ` +
        "The invariant changed since the proof was produced — teeth proves the test bites for the ORIGINAL invariant, " +
        "not this one. Re-run `stele incident teeth`.",
      ExitCode.USER_ERROR,
    );
  }
}

/**
 * The mutation set approve restores on a mid-sequence failure. `before === null`
 * means "did not exist" so the restore DELETEs it (a freshly-created proposals
 * file / manifest / PROPOSAL_IMPORT line must not linger).
 */
type FileSnapshot = { path: string; before: string | null };

async function snapshotFile(absPath: string): Promise<FileSnapshot> {
  const before = await readOptionalFile(absPath);
  return { path: absPath, before: before ?? null };
}

async function restoreFile(snap: FileSnapshot): Promise<void> {
  if (snap.before === null) {
    await rm(snap.path, { force: true });
  } else {
    await mkdir(dirname(snap.path), { recursive: true });
    await writeFile(snap.path, snap.before, "utf8");
  }
}

/** Recursive byte snapshot of a directory tree (path -> bytes). */
async function snapshotDir(absDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      const st = await stat(full);
      if (st.isDirectory()) await walk(full);
      else out.set(full, await readFile(full, "utf8"));
    }
  };
  await walk(absDir);
  return out;
}

async function restoreDir(absDir: string, before: Map<string, string>): Promise<void> {
  const after = await snapshotDir(absDir);
  for (const path of after.keys()) {
    if (!before.has(path)) await rm(path, { force: true });
  }
  for (const [path, bytes] of before) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, "utf8");
  }
}

export type TeethGateResult = {
  verdict: "TEETH_PROVEN" | "TEETH_UNAVAILABLE";
  teethUnavailable: boolean;
  unavailableReason?: string;
};

/**
 * The HARD GATE. TEETH_PROVEN passes; an absent proof (or one already recorded
 * TEETH_UNAVAILABLE) is acceptable ONLY with --teeth-unavailable-reason (records
 * the reason + the teeth:unproven tag); TEETH_FAILED ALWAYS refuses, even with a
 * reason — an unavailable-reason can never launder a FAILED verdict.
 */
function enforceTeethGate(
  teeth: TeethProof | null,
  reason: string | undefined,
): TeethGateResult {
  if (teeth !== null && teeth.verdict === "TEETH_FAILED") {
    throw new CliCommandError(
      "Teeth proof verdict is TEETH_FAILED: the negative test did not FAIL at <fix>^ AND PASS at <fix>. " +
        "Refusing to approve. Revise the draft and re-run `stele incident teeth`. " +
        "A --teeth-unavailable-reason cannot override a FAILED verdict.",
      ExitCode.USER_ERROR,
    );
  }

  if (teeth !== null && teeth.verdict === "TEETH_PROVEN") {
    return { verdict: "TEETH_PROVEN", teethUnavailable: false };
  }

  const trimmed = reason?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    throw new CliCommandError(
      "No TEETH_PROVEN proof at .stele/proofs/<id>/teeth.json. " +
        "Run `stele incident teeth` to produce one, OR pass --teeth-unavailable-reason " +
        '"<why the teeth proof could not be produced>" to approve as teeth:unproven.',
      ExitCode.USER_ERROR,
    );
  }
  return { verdict: "TEETH_UNAVAILABLE", teethUnavailable: true, unavailableReason: trimmed };
}

function buildIncidentApprovalPath(projectDir: string, id: string): string {
  // Wall-clock-named filename, but lives under .stele/incident/<id>/ (scratch,
  // NEVER hashed — C2 SCRATCH_NEVER_HASHED), so the nondeterministic name does
  // not affect manifest stability.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 22);
  return join(incidentScratchDir(projectDir, id), `approval-${ts}.json`);
}

/**
 * The atomic apply → generate → lock sink. Accepts ONLY a `ProvenDraft<"Bound">`
 * witness — a caller cannot reach this function without first routing the draft
 * through `draftProvenDraft` → `markTeethProven` (after enforceTeethGate) →
 * `bindTeethProof` (after enforceTeethBinding, or in the teeth-unavailable
 * branch). This is the type-state INCIDENT_LIFECYCLE sink; it defends the code
 * path against future refactors/new callers skipping the teeth gate. The
 * runtime tamper-evidence checks (enforceTeethGate, enforceTeethBinding) are
 * orthogonal and stay where they are.
 *
 * Takes its OWN OUTER snapshot of the mutation set BEFORE any write, and on a
 * mid-sequence failure restores the pre-call snapshot exactly (so the tree
 * never lingers at stele-check exit-2/3), then re-throws the native code. All
 * data (invariant/rationale/tags/draft) is read off the Bound witness.
 */
async function applyGenerateLock(
  bound: ProvenDraft<"Bound">,
  ctx: {
    projectDir: string;
    config: Awaited<ReturnType<typeof loadConfig>>;
    propose: typeof runPropose;
    generate: typeof runGenerate;
    lock: typeof runLock;
    /** Committed provenance record to write atomically (null = teeth-unavailable). */
    provenance: ProvenanceRecord | null;
  },
): Promise<void> {
  const { projectDir, config, propose, generate, lock, provenance } = ctx;
  const { id, invariant, rationale, tags } = bound;

  // OUTER snapshot of the mutation set BEFORE any write. The provenance record
  // is part of the set: snapshotFile records its ABSENCE so a mid-sequence
  // failure's rollback deletes it (the record must never outlive a failed lock).
  const entryAbs = resolve(projectDir, config.entry);
  const proposalAbs = resolve(projectDir, PROPOSAL_FILE);
  const manifestAbs = resolve(projectDir, config.manifestPath);
  const generatedDirAbs = resolve(projectDir, config.generatedDir);
  const provenanceAbs = provenance ? provenancePath(projectDir, id) : null;

  const entrySnap = await snapshotFile(entryAbs);
  const proposalSnap = await snapshotFile(proposalAbs);
  const manifestSnap = await snapshotFile(manifestAbs);
  const generatedSnap = await snapshotDir(generatedDirAbs);
  const provenanceSnap = provenanceAbs ? await snapshotFile(provenanceAbs) : null;

  const rollback = async (): Promise<void> => {
    if (provenanceSnap) await restoreFile(provenanceSnap);
    await restoreFile(entrySnap);
    await restoreFile(proposalSnap);
    await restoreDir(generatedDirAbs, generatedSnap);
    await restoreFile(manifestSnap);
  };

  // atomic apply → generate → lock → write provenance.
  try {
    await propose(projectDir, {
      kind: "invariant",
      id: invariant.id,
      severity: invariant.severity,
      description: invariant.description,
      assert: invariant.assert,
      category: invariant.category,
      rationale,
      tags: [...tags],
      apply: true,
    });
    await generate(projectDir, { force: true });
    await lock(projectDir, { reason: `incident:${id}` });
    if (provenance) {
      await writeProvenance(projectDir, provenance);
    }
  } catch (error) {
    // restore the pre-call snapshot exactly, then re-throw the native code.
    await rollback();
    throw error;
  }
}

/**
 * Read teeth.json + draft.json → enforce the teeth hard-gate → resolve human
 * identity → apply (runPropose --apply) → generate → lock as ONE operation under
 * an OUTER snapshot/rollback → write a signed approval record under scratch.
 *
 * Every refusal throws CliCommandError(ExitCode.USER_ERROR=1). A mid-sequence
 * apply/generate/lock failure restores the pre-call snapshot exactly (so the
 * tree never lingers at stele-check exit-2/3) and re-throws the native code. No
 * new exit code; manifest format unchanged.
 */
export async function runIncidentApprove(
  projectDir: string,
  options: IncidentApproveOptions,
  deps: {
    runPropose?: typeof runPropose;
    runGenerate?: typeof runGenerate;
    runLock?: typeof runLock;
    resolveApprovedBy?: typeof resolveApprovedBy;
    stdout?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const out = deps.stdout ?? process.stdout;
  const propose = deps.runPropose ?? runPropose;
  const generate = deps.runGenerate ?? runGenerate;
  const lock = deps.runLock ?? runLock;
  const identityGate = deps.resolveApprovedBy ?? resolveApprovedBy;

  // (1) id path-safety BEFORE any IO.
  let id: string;
  try {
    id = validateIncidentId(options.id);
  } catch (error) {
    throw new CliCommandError((error as Error).message, ExitCode.USER_ERROR);
  }

  // (2) teeth gate.
  const teeth = await readTeeth(projectDir, id);
  const gate = enforceTeethGate(teeth, options.teethUnavailableReason);

  // (3) human-identity gate — same shape/denylist as `stele design approve`. A
  // supplied --approved-by is fed through the SAME env-var gate (it must NOT
  // bypass the denylist); STELE_APPROVED_BY remains the primary path.
  const priorEnv = process.env.STELE_APPROVED_BY;
  if (options.approvedBy !== undefined) {
    process.env.STELE_APPROVED_BY = options.approvedBy;
  }
  let approver: { ok: true; approvedBy: string } | { ok: false; reason: string };
  try {
    approver = identityGate();
  } finally {
    if (options.approvedBy !== undefined) {
      if (priorEnv === undefined) delete process.env.STELE_APPROVED_BY;
      else process.env.STELE_APPROVED_BY = priorEnv;
    }
  }
  if (!approver.ok) {
    throw new CliCommandError(approver.reason, ExitCode.USER_ERROR);
  }

  // (4) read + re-validate the draft.
  const draft = await readDraft(projectDir, id);
  const invariant = parseInvariantFromDraft(draft);

  // (4c) INCIDENT_LIFECYCLE witness — mint Drafted then promote to TeethProven
  // immediately after the teeth gate passed (still pre-binding). The witness is
  // a phantom-typed proof-of-ordering: the apply→generate→lock sink accepts only
  // a Bound witness, so no caller can reach it without routing through the gate.
  const tags = gate.teethUnavailable
    ? [PROVENANCE_TAG, TEETH_UNPROVEN_TAG]
    : [PROVENANCE_TAG];
  // When teeth could not be proven, the operator-supplied reason is part of the
  // permanent record: it is woven into BOTH the locked invariant's rationale
  // (here) AND the signed approval record's `reason` (below), so a teeth:unproven
  // invariant carries its justification wherever it is read, not only in the gate
  // predicate.
  const rationaleSuffix = gate.teethUnavailable
    ? `fix:${draft.fixSha}; teeth-unavailable: ${gate.unavailableReason}`
    : `fix:${draft.fixSha}`;
  const rationale = invariant.rationale
    ? `${invariant.rationale} (${rationaleSuffix})`
    : `incident ${id} ${rationaleSuffix}`;

  const proven = markTeethProven(
    draftProvenDraft({
      id,
      invariant,
      rationale,
      tags,
      draft,
      approvedBy: approver.approvedBy,
      teethVerdict: gate.verdict,
      unavailableReason: gate.unavailableReason,
    }),
  );

  // (4b) teeth-binding gate: when the verdict is TEETH_PROVEN, the proof MUST
  // attest to THIS draft. In the teeth-unavailable branch the binding check is
  // skipped (no proof to bind) — both branches legitimately reach Bound (see
  // incident-lifecycle.ts header).
  if (!gate.teethUnavailable) {
    if (teeth === null) {
      throw new CliCommandError(
        "Internal error: TEETH_PROVEN verdict with no teeth proof.",
        ExitCode.USER_ERROR,
      );
    }
    await enforceTeethBinding(projectDir, id, teeth, draft);
  }
  const bound = bindTeethProof(proven);

  // Build the COMMITTED provenance record for a genuinely-proven incident, so
  // `stele incident reverify` can re-derive the verdict from git later. Only the
  // TEETH_PROVEN branch produces one — a teeth-unavailable approval has no
  // re-runnable proof. All fields come from the proof + draft (no wall-clock:
  // producedAtFromGit is the fix committer date).
  const provenance: ProvenanceRecord | null =
    !gate.teethUnavailable && teeth !== null
      ? {
          schemaVersion: 1,
          incidentId: id,
          invariantId: invariant.id,
          parentSha: draft.parentSha,
          fixSha: draft.fixSha,
          testFilename: draft.testFilename,
          negativeTest: draft.negativeTest,
          testSha256: teeth.testSha256,
          invariantCdl: draft.invariantCdl,
          invariantSha256: teeth.invariantSha256,
          verdict: teeth.verdict,
          parentBiteClass: teeth.parentBiteClass,
          producedAtFromGit: teeth.producedAtFromGit,
        }
      : null;

  // (5+6) atomic apply → generate → lock → provenance under the sink's OUTER
  // snapshot/rollback. The sink accepts ONLY the Bound witness for the contract
  // mutation; the provenance record rides the same atomic set.
  const config = await loadConfig(projectDir);
  await applyGenerateLock(bound, { projectDir, config, propose, generate, lock, provenance });

  // (8) only after the sequence succeeds, write the signed approval record under
  // scratch via the typed lifecycle chain.
  const approvalPath = buildIncidentApprovalPath(projectDir, id);
  const payload: ApprovalPayload = {
    schema_version: 1,
    base_profile_sha256: draft.parentSha,
    approved_profile_sha256: draft.fixSha,
    approved_proposals: [],
    diff_classification: "incident",
    affected_generated_rules: [invariant.id],
    affected_source_scope: [],
    reason: gate.teethUnavailable
      ? `incident:${id} teeth-unavailable: ${gate.unavailableReason}`
      : `incident:${id} teeth:proven`,
    approved_by: approver.approvedBy,
    approved_at: new Date().toISOString(),
  };
  const signed = signApproval(attachApprovedBy(draftApproval(payload)));
  await mkdir(dirname(approvalPath), { recursive: true });
  writeSignedApproval(signed, approvalPath);

  out.write(`Approved incident ${id} (${gate.verdict}).\n`);
  out.write(`  invariant      ${invariant.id}\n`);
  out.write(`  tags           ${tags.join(" ")}\n`);
  out.write(`  fix            ${draft.fixSha}\n`);
  out.write(`  approved by    ${approver.approvedBy}\n`);
  out.write(`  approval       ${approvalPath}\n`);
  if (provenance) {
    out.write(`  provenance     contract/provenance/${id}.json  (stele incident reverify --id ${id})\n`);
  }
  if (gate.teethUnavailable) {
    out.write(`  teeth          UNPROVEN: ${gate.unavailableReason}\n`);
  }
}

/**
 * Attach the `approve` subcommand to the shared `incident` parent (created once
 * in incident/index.ts). Mirrors the draft + teeth registration idiom; the
 * action wraps runIncidentApprove and maps any error to its existing exit code.
 */
export function registerIncidentApprove(incident: Command): void {
  incident
    .command(commandName("approve"))
    .description(
      "Approve an incident: enforce the teeth gate, then atomically apply→generate→lock the provenance-tagged invariant.",
    )
    .requiredOption("--id <id>", "incident id (from `stele incident draft`)")
    .option("--approved-by <who>", "human-identifying approver token (email or scoped id)")
    .option(
      "--teeth-unavailable-reason <reason>",
      "approve as teeth:unproven when no TEETH_PROVEN proof exists (records the reason)",
    )
    .action(
      async (opts: { id: string; approvedBy?: string; teethUnavailableReason?: string }) => {
        try {
          await runIncidentApprove(process.cwd(), {
            id: opts.id,
            approvedBy: opts.approvedBy,
            teethUnavailableReason: opts.teethUnavailableReason,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`error: ${message}\n`);
          process.exitCode = getExitCode(error) ?? 1;
        }
      },
    );
}
