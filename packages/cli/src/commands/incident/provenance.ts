import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { BiteClass } from "./teeth-runners.js";
import type { TeethVerdict } from "./teeth.js";
import { validateIncidentId } from "./shared.js";

/**
 * The COMMITTED incident provenance record at `contract/provenance/<id>.json`.
 * Unlike the teeth proof (`.stele/proofs/<id>/teeth.json`, scratch — gone after
 * the run), this record is durable and lives in git, so `stele incident reverify`
 * (and any third party with the repo) can re-derive the teeth verdict from the
 * recorded SHAs + test bytes on demand. It carries everything reverify needs to
 * re-run: the SHAs, the negative-test bytes, and the hashes/verdict to compare
 * against.
 */
export type ProvenanceRecord = {
  schemaVersion: 1;
  incidentId: string;
  invariantId: string;
  parentSha: string;
  fixSha: string;
  testFilename: string;
  negativeTest: string;
  testSha256: string;
  invariantCdl: string;
  invariantSha256: string;
  verdict: TeethVerdict;
  parentBiteClass: BiteClass;
  producedAtFromGit: string;
};

const PROVENANCE_SUBDIR = "contract/provenance";

function canonicalize(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * resolve(projectDir, 'contract/provenance', validateIncidentId(id) + '.json')
 * with a containment guard mirroring shared.containedScratchDir, so a hostile id
 * can never escape the provenance directory.
 */
export function provenancePath(projectDir: string, id: string): string {
  validateIncidentId(id);
  const root = resolve(projectDir, PROVENANCE_SUBDIR);
  const target = resolve(root, `${id}.json`);
  const rel = relative(canonicalize(root), canonicalize(target));
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Refusing provenance path that escapes ${PROVENANCE_SUBDIR}: id ${JSON.stringify(id)}.`,
    );
  }
  return target;
}

/** Byte-stable serialization (fixed key order, trailing newline). */
export function serializeProvenance(record: ProvenanceRecord): string {
  const ordered = {
    schemaVersion: record.schemaVersion,
    incidentId: record.incidentId,
    invariantId: record.invariantId,
    parentSha: record.parentSha,
    fixSha: record.fixSha,
    testFilename: record.testFilename,
    negativeTest: record.negativeTest,
    testSha256: record.testSha256,
    invariantCdl: record.invariantCdl,
    invariantSha256: record.invariantSha256,
    verdict: record.verdict,
    parentBiteClass: record.parentBiteClass,
    producedAtFromGit: record.producedAtFromGit,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeProvenance(
  projectDir: string,
  record: ProvenanceRecord,
): Promise<string> {
  const path = provenancePath(projectDir, record.incidentId);
  await fs.mkdir(resolve(projectDir, PROVENANCE_SUBDIR), { recursive: true });
  await fs.writeFile(path, serializeProvenance(record), "utf8");
  return path;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const VALID_VERDICTS: readonly TeethVerdict[] = ["TEETH_PROVEN", "TEETH_FAILED", "TEETH_UNAVAILABLE"];
const VALID_BITE: readonly BiteClass[] = ["assertion", "collection-or-build", "unknown", "passed"];

function asProvenance(value: unknown): ProvenanceRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed provenance record: not an object.");
  }
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== 1) {
    throw new Error("Malformed provenance record: schemaVersion must be 1.");
  }
  for (const key of [
    "incidentId",
    "invariantId",
    "parentSha",
    "fixSha",
    "testFilename",
    "negativeTest",
    "testSha256",
    "invariantCdl",
    "invariantSha256",
    "producedAtFromGit",
  ] as const) {
    if (!nonEmpty(obj[key])) {
      throw new Error(`Malformed provenance record: field '${key}' must be a non-empty string.`);
    }
  }
  if (typeof obj.verdict !== "string" || !VALID_VERDICTS.includes(obj.verdict as TeethVerdict)) {
    throw new Error(`Malformed provenance record: 'verdict' invalid.`);
  }
  if (typeof obj.parentBiteClass !== "string" || !VALID_BITE.includes(obj.parentBiteClass as BiteClass)) {
    throw new Error(`Malformed provenance record: 'parentBiteClass' invalid.`);
  }
  return {
    schemaVersion: 1,
    incidentId: obj.incidentId as string,
    invariantId: obj.invariantId as string,
    parentSha: obj.parentSha as string,
    fixSha: obj.fixSha as string,
    testFilename: obj.testFilename as string,
    negativeTest: obj.negativeTest as string,
    testSha256: obj.testSha256 as string,
    invariantCdl: obj.invariantCdl as string,
    invariantSha256: obj.invariantSha256 as string,
    verdict: obj.verdict as TeethVerdict,
    parentBiteClass: obj.parentBiteClass as BiteClass,
    producedAtFromGit: obj.producedAtFromGit as string,
  };
}

export async function readProvenance(projectDir: string, id: string): Promise<ProvenanceRecord> {
  const path = provenancePath(projectDir, id);
  const raw = await fs.readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed provenance record at ${path}: ${(error as Error).message}`);
  }
  return asProvenance(parsed);
}

/** List incident ids that have a committed provenance record. */
export async function listProvenanceIds(projectDir: string): Promise<string[]> {
  const dir = resolve(projectDir, PROVENANCE_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".json"))
    .map((e) => e.slice(0, -".json".length))
    .sort();
}
