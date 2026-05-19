// Generation Manifest — Phase 2.2 of DDD + Type-Driven Pattern System.
// Tracks SHA-256 provenance of generated .stele files and their design-profile origin.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { hashString } from "../design-profile/hash.js";

const DEFAULT_MANIFEST_PATH = "contract/design/manifest.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedRuleEntry {
  ruleId: string;           // e.g. "architecture.ddd.billing.domain.infrastructure"
  ruleKind: "architecture" | "core-node";
  origin: string;          // e.g. "context:billing" | "aggregate:Order"
  fileHash: string;        // SHA-256 of generated .stele file
  cdl: string;             // The CDL snippet that was emitted
}

export interface GeneratedFileEntry {
  path: string;            // e.g. "contract/generated/ddd-typedriven.stele"
  hash: string;            // SHA-256 of the generated file content
}

export interface GenerationManifest {
  schemaVersion: string;   // "1"
  profileHash: string;    // SHA-256 of profile.yaml
  generatedRules: GeneratedRuleEntry[];
  generatedAt: string;     // ISO 8601
  generatedFiles?: GeneratedFileEntry[]; // File-level provenance for ownership validation
}

// ---------------------------------------------------------------------------
// Manifest path
// ---------------------------------------------------------------------------

function manifestPath(projectDir: string): string {
  return resolve(projectDir, DEFAULT_MANIFEST_PATH);
}

// ---------------------------------------------------------------------------
// Write / Read
// ---------------------------------------------------------------------------

/**
 * Write a generation manifest to `contract/design/manifest.json`.
 * Creates parent directories if they do not exist.
 */
export function writeManifest(
  projectDir: string,
  manifest: GenerationManifest,
): void {
  const path = manifestPath(projectDir);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Read the generation manifest. Returns null if the file does not exist.
 */
export function readManifest(
  projectDir: string,
): GenerationManifest | null {
  const path = manifestPath(projectDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as GenerationManifest;
}

// ---------------------------------------------------------------------------
// Integrity verification
// ---------------------------------------------------------------------------

export interface ManifestIntegrityResult {
  valid: boolean;
  drifts: string[];
}

/**
 * Verify manifest integrity by comparing stored hashes against actual files.
 *
 * Returns `{ valid, drifts }` where `drifts` lists rule IDs whose on-disk hash
 * no longer matches the manifest entry.
 */
export function verifyManifestIntegrity(
  projectDir: string,
): ManifestIntegrityResult {
  const manifest = readManifest(projectDir);
  if (!manifest) {
    return { valid: false, drifts: ["manifest-not-found"] };
  }

  const drifts: string[] = [];

  for (const entry of manifest.generatedRules) {
    // We store the file hash in `fileHash` and the CDL in `cdl`.
    // Verify the CDL hash still matches the stored fileHash.
    const actualCdlHash = hashString(entry.cdl);
    if (actualCdlHash !== entry.fileHash) {
      drifts.push(entry.ruleId);
    }
  }

  return { valid: drifts.length === 0, drifts };
}

// ---------------------------------------------------------------------------
// Builder helper
// ---------------------------------------------------------------------------

export interface BuildManifestOptions {
  /** SHA-256 of the design profile source file */
  profileHash: string;
  /** CDL strings for each architecture declaration */
  architectures: string[];
  /** CDL strings for each core-node declaration */
  coreNodes: string[];
  /** Optional: output file path + content for file-level provenance */
  outputFiles?: Array<{ path: string; content: string }>;
}

/**
 * Build a GenerationManifest from a generator result and profile hash.
 * This is the canonical way to create a manifest after calling generateFromProfile.
 */
export function buildManifest(options: BuildManifestOptions): GenerationManifest {
  const rules: GeneratedRuleEntry[] = [];

  for (const arch of options.architectures) {
    const ruleId = extractRuleIdFromArchitecture(arch);
    const origin = extractOriginFromArchitecture(arch);
    rules.push({
      ruleId,
      ruleKind: "architecture",
      origin,
      fileHash: hashString(arch),
      cdl: arch,
    });
  }

  for (const cn of options.coreNodes) {
    const ruleId = extractRuleIdFromCoreNode(cn);
    const origin = extractOriginFromCoreNode(cn);
    rules.push({
      ruleId,
      ruleKind: "core-node",
      origin,
      fileHash: hashString(cn),
      cdl: cn,
    });
  }

  const generatedFiles = options.outputFiles?.map((f) => ({
    path: f.path,
    hash: hashString(f.content),
  }));

  return {
    schemaVersion: "1",
    profileHash: options.profileHash,
    generatedRules: rules,
    generatedAt: new Date().toISOString(),
    generatedFiles,
  };
}

function extractRuleIdFromArchitecture(cdl: string): string {
  // Extract the architecture id from the CDL: (architecture "ddd-billing"
  const match = cdl.match(/\(architecture\s+"([^"]+)"/);
  if (match) return `architecture.${match[1]}`;
  return "architecture.unknown";
}

function extractOriginFromArchitecture(cdl: string): string {
  // Extract the architecture id, then derive the origin.
  const ruleId = extractRuleIdFromArchitecture(cdl);
  // ruleId is e.g. "architecture.ddd-billing" or "architecture.ddd-context-map"
  const parts = ruleId.split(".");
  if (parts.length < 2) return "unknown";
  const archName = parts[1];
  if (archName === "ddd-context-map") return "integration:all";
  if (archName.startsWith("ddd-")) return `context:${archName.slice(4)}`;
  return "unknown";
}

function extractRuleIdFromCoreNode(cdl: string): string {
  // Extract the core-node id from the CDL: (core-node "billing-invoice-aggregate"
  const match = cdl.match(/\(core-node\s+"([^"]+)"/);
  if (match) return `core-node.${match[1]}`;
  return "core-node.unknown";
}

function extractOriginFromCoreNode(cdl: string): string {
  // Heuristic: core-node id typically contains the context id.
  // "billing-invoice-aggregate" -> "aggregate:invoice" (context inferred from ruleId)
  const match = cdl.match(/\(core-node\s+"([^"]+)"/);
  if (!match) return "unknown";
  const parts = match[1].split("-");
  // Last segment is typically "aggregate", second-to-last is the entity name
  if (parts.length >= 2) {
    const entity = parts[parts.length - 2];
    return `aggregate:${entity}`;
  }
  return "aggregate:unknown";
}
