import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { isMissingFileError } from "../../utils/shared-utils.js";
import type { TeethProof, TeethVerdict } from "./teeth.js";
import { type BiteClass, assertSafeTestBasename } from "./teeth-runners.js";

const execFileAsync = promisify(execFile);

/**
 * Re-export the teeth proof types from the single scratch-IO seam so approve
 * (and the MCP tools) import every incident type + helper from shared.ts and
 * never reach into teeth.ts directly. `import type` is erased at runtime, so the
 * teeth ⇄ shared cycle is type-only and harmless.
 */
export type { TeethProof, TeethVerdict };

/**
 * The JSON shape read from `--draft-from` (the injected bring-your-own-model /
 * agent-supplied seam). This is the only probabilistic input to the wedge and is
 * always supplied deterministically as a file or stdin payload.
 */
export type DraftInput = {
  invariantCdl: string;
  negativeTest: string;
  testFilename?: string;
};

/**
 * The on-disk `draft.json` shape. `testFilename` is always resolved (defaults to
 * `test_incident_<id>.py`). Consumed by teeth + approve.
 */
export type IncidentDraft = {
  intent: string;
  fixSha: string;
  parentSha: string;
  invariantCdl: string;
  negativeTest: string;
  testFilename: string;
};

const INCIDENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

const INCIDENT_SUBDIR = ".stele/incident";
const PROOFS_SUBDIR = ".stele/proofs";

/**
 * Lowercase, replace every run of non-[a-z0-9] with '-', trim leading/trailing
 * '-', collapse repeats. Throws if the result is empty.
 */
export function slugifyIncidentId(intent: string): string {
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (slug.length === 0) {
    throw new Error(
      `Cannot derive incident id from intent ${JSON.stringify(intent)}: ` +
        "no alphanumeric characters. Supply --id explicitly.",
    );
  }
  return slug;
}

/**
 * Returns `id` iff it matches /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (path-safe: rejects
 * '.', '..', '/', '\\', leading/trailing '-', uppercase, empty); throws
 * otherwise. Applied to BOTH derived and --id-supplied ids.
 */
export function validateIncidentId(id: string): string {
  if (!INCIDENT_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid incident id ${JSON.stringify(id)}: must match ` +
        "/^[a-z0-9]+(?:-[a-z0-9]+)*$/ (lowercase alphanumerics separated by single hyphens).",
    );
  }
  return id;
}

function canonicalizeForComparison(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function containedScratchDir(projectDir: string, subdir: string, id: string): string {
  validateIncidentId(id);
  const root = resolve(projectDir, subdir);
  const target = resolve(root, id);
  const rel = relative(
    canonicalizeForComparison(root),
    canonicalizeForComparison(target),
  );
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Refusing incident path that escapes ${subdir}: id ${JSON.stringify(id)} ` +
        `resolves outside the scratch root.`,
    );
  }
  return target;
}

/**
 * resolve(projectDir, '.stele/incident', validateIncidentId(id)) with a
 * defense-in-depth containment guard mirroring addChecker's relative()-stays-
 * inside-root check.
 */
export function incidentScratchDir(projectDir: string, id: string): string {
  return containedScratchDir(projectDir, INCIDENT_SUBDIR, id);
}

/**
 * Same guard for resolve(projectDir, '.stele/proofs', id). Declared here for
 * teeth/approve reuse; draft does not write proofs.
 */
export function proofsScratchDir(projectDir: string, id: string): string {
  return containedScratchDir(projectDir, PROOFS_SUBDIR, id);
}

export function draftJsonPath(projectDir: string, id: string): string {
  return join(incidentScratchDir(projectDir, id), "draft.json");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * JSON.parse + validate {invariantCdl:non-empty string, negativeTest:non-empty
 * string, testFilename?:string}. When testFilename is present it must be a bare,
 * path-safe basename ending in a supported test extension (`assertSafeTestBasename`
 * — .py/.ts/.js/.mjs/.cjs/.rs); separators, traversal, and unsupported languages
 * (e.g. .go/.java/.txt) are rejected — closing the agent-supplied path-escape
 * vector and dead-end drafts in one place.
 */
export function parseDraftInput(raw: string): DraftInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Draft input is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Draft input must be a JSON object.");
  }
  const obj = parsed as Record<string, unknown>;
  if (!nonEmptyString(obj.invariantCdl)) {
    throw new Error("Draft input field 'invariantCdl' must be a non-empty string.");
  }
  if (!nonEmptyString(obj.negativeTest)) {
    throw new Error("Draft input field 'negativeTest' must be a non-empty string.");
  }
  const result: DraftInput = {
    invariantCdl: obj.invariantCdl,
    negativeTest: obj.negativeTest,
  };
  if (obj.testFilename !== undefined) {
    if (typeof obj.testFilename !== "string") {
      throw new Error("Draft input field 'testFilename' must be a string.");
    }
    // Throws a precise message naming the supported extensions on any unsafe /
    // unsupported value; the word "testFilename" is preserved in the message.
    result.testFilename = assertSafeTestBasename(obj.testFilename);
  }
  return result;
}

function serializeDraft(draft: IncidentDraft): string {
  // Fixed key order — byte-stable, no Object.keys reordering.
  const ordered = {
    intent: draft.intent,
    fixSha: draft.fixSha,
    parentSha: draft.parentSha,
    invariantCdl: draft.invariantCdl,
    negativeTest: draft.negativeTest,
    testFilename: draft.testFilename,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeDraftJson(
  projectDir: string,
  id: string,
  draft: IncidentDraft,
): Promise<void> {
  const dir = incidentScratchDir(projectDir, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "draft.json"), serializeDraft(draft), "utf8");
}

function asIncidentDraft(value: unknown): IncidentDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed draft.json: not an object.");
  }
  const obj = value as Record<string, unknown>;
  for (const key of [
    "intent",
    "fixSha",
    "parentSha",
    "invariantCdl",
    "negativeTest",
    "testFilename",
  ] as const) {
    if (!nonEmptyString(obj[key])) {
      throw new Error(`Malformed draft.json: field '${key}' must be a non-empty string.`);
    }
  }
  return {
    intent: obj.intent as string,
    fixSha: obj.fixSha as string,
    parentSha: obj.parentSha as string,
    invariantCdl: obj.invariantCdl as string,
    negativeTest: obj.negativeTest as string,
    testFilename: obj.testFilename as string,
  };
}

export async function readDraftJson(
  projectDir: string,
  id: string,
): Promise<IncidentDraft> {
  const path = draftJsonPath(projectDir, id);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(
        `No incident draft for id ${JSON.stringify(id)}: ${path} does not exist. ` +
          "Run `stele incident draft` first.",
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed draft.json at ${path}: ${(error as Error).message}`);
  }
  return asIncidentDraft(parsed);
}

/** Alias matching the public surface name `approve` (and the MCP tools) import. */
export const readDraft = readDraftJson;

/**
 * resolve(.stele/proofs/<id>/teeth.json) through the contained-scratch guard.
 * The single source of truth for the teeth proof path so approve never builds
 * the path by hand.
 */
export function teethJsonPath(projectDir: string, id: string): string {
  return join(proofsScratchDir(projectDir, id), "teeth.json");
}

function asTeethProof(value: unknown): TeethProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed teeth.json: not an object.");
  }
  const obj = value as Record<string, unknown>;
  const verdict = obj.verdict;
  const VALID_VERDICTS: readonly TeethVerdict[] = [
    "TEETH_PROVEN",
    "TEETH_FAILED",
    "TEETH_UNAVAILABLE",
  ];
  if (typeof verdict !== "string" || !VALID_VERDICTS.includes(verdict as TeethVerdict)) {
    throw new Error(
      `Malformed teeth.json: 'verdict' must be one of ${VALID_VERDICTS.join(", ")}.`,
    );
  }
  const VALID_BITE: readonly BiteClass[] = ["assertion", "collection-or-build", "unknown", "passed"];
  if (typeof obj.parentBiteClass !== "string" || !VALID_BITE.includes(obj.parentBiteClass as BiteClass)) {
    throw new Error(
      `Malformed teeth.json: 'parentBiteClass' must be one of ${VALID_BITE.join(", ")}.`,
    );
  }
  for (const key of ["parentSha", "fixSha", "testSha256", "invariantSha256", "producedAtFromGit"] as const) {
    if (!nonEmptyString(obj[key])) {
      throw new Error(`Malformed teeth.json: field '${key}' must be a non-empty string.`);
    }
  }
  const asRun = (raw: unknown, label: string): { exit: number; outputSha256: string } => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`Malformed teeth.json: '${label}' must be an object.`);
    }
    const run = raw as Record<string, unknown>;
    if (typeof run.exit !== "number") {
      throw new Error(`Malformed teeth.json: '${label}.exit' must be a number.`);
    }
    if (!nonEmptyString(run.outputSha256)) {
      throw new Error(`Malformed teeth.json: '${label}.outputSha256' must be a non-empty string.`);
    }
    return { exit: run.exit, outputSha256: run.outputSha256 };
  };
  return {
    verdict: verdict as TeethVerdict,
    parentSha: obj.parentSha as string,
    fixSha: obj.fixSha as string,
    testSha256: obj.testSha256 as string,
    invariantSha256: obj.invariantSha256 as string,
    parentBiteClass: obj.parentBiteClass as BiteClass,
    parentRun: asRun(obj.parentRun, "parentRun"),
    fixRun: asRun(obj.fixRun, "fixRun"),
    producedAtFromGit: obj.producedAtFromGit as string,
  };
}

/**
 * Read .stele/proofs/<id>/teeth.json. Returns `null` (not a throw) when the file
 * is ABSENT so approve can distinguish "no proof was produced" (→ requires
 * --teeth-unavailable-reason) from "proof exists but is malformed" (→ a hard
 * error). A present-but-corrupt proof throws.
 */
export async function readTeeth(
  projectDir: string,
  id: string,
): Promise<TeethProof | null> {
  const path = teethJsonPath(projectDir, id);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed teeth.json at ${path}: ${(error as Error).message}`);
  }
  return asTeethProof(parsed);
}

/**
 * Writes draft.negativeTest to join(incidentScratchDir, basename(testFilename));
 * returns the absolute path. basename() is belt-and-suspenders even though
 * parseDraftInput already rejects separators.
 */
export async function writeCandidateTest(
  projectDir: string,
  id: string,
  draft: IncidentDraft,
): Promise<string> {
  const dir = incidentScratchDir(projectDir, id);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, basename(draft.testFilename));
  await fs.writeFile(path, draft.negativeTest, "utf8");
  return path;
}

async function runGit(projectDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: projectDir });
    return stdout.trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new Error("git is not available on PATH; cannot resolve revisions.");
    }
    const detail = err.stderr ? err.stderr.trim() : err.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function assertSha(sha: string, context: string): string {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`Expected a 40-char SHA for ${context} but got ${JSON.stringify(sha)}.`);
  }
  return sha;
}

/**
 * Resolves <fix> and <fix>^ to full 40-char SHAs. Throws typed errors for
 * git-unavailable, unknown rev, or root commit (no parent).
 */
export async function resolveFixAndParent(
  projectDir: string,
  fixRev: string,
): Promise<{ fixSha: string; parentSha: string }> {
  let fixSha: string;
  try {
    fixSha = await runGit(projectDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${fixRev}^{commit}`,
    ]);
  } catch (error) {
    throw new Error(
      `Cannot resolve fix revision ${JSON.stringify(fixRev)}: ${(error as Error).message}`,
    );
  }
  if (fixSha.length === 0) {
    throw new Error(`Unknown fix revision ${JSON.stringify(fixRev)}.`);
  }
  assertSha(fixSha, "fix commit");

  let parentSha: string;
  try {
    parentSha = await runGit(projectDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${fixRev}^^{commit}`,
    ]);
  } catch {
    parentSha = "";
  }
  if (parentSha.length === 0) {
    throw new Error(
      `Fix revision ${JSON.stringify(fixRev)} (${fixSha}) is a root commit with no parent; ` +
        "the teeth proof needs a parent (<fix>^) to test against.",
    );
  }
  assertSha(parentSha, "parent commit");
  return { fixSha, parentSha };
}

/**
 * `git show -s --format=%cI <fixSha>` — the committer date as ISO-8601. Used for
 * teeth.json producedAtFromGit so the proof is reproducible (never new Date()).
 */
export async function fixCommitterDate(
  projectDir: string,
  fixSha: string,
): Promise<string> {
  const out = await runGit(projectDir, [
    "show",
    "-s",
    "--format=%cI",
    fixSha,
  ]);
  if (out.length === 0) {
    throw new Error(`Cannot read committer date for ${fixSha}.`);
  }
  return out;
}
