// Source-root Ownership Validation — Phase 2.2 of DDD + Type-Driven Pattern System.
// Validates that generated output files are owned by the design profile, not hand-edited.

import { statSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";

import { hashFile } from "../design-profile/hash.js";
import { readManifest, type GenerationManifest, type GeneratedFileEntry } from "./manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERATED_DIR = "contract/generated";

export interface OwnershipResult {
  owned: boolean;           // All generated files have valid manifest provenance
  orphanCount: number;     // Files in generated/ that are NOT in manifest
  missingCount: number;    // Manifest entries with no matching file
  unexpectedEdits: string[]; // Files whose hash doesn't match manifest
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate that every file under `contract/generated/` is accounted for in the
 * generation manifest, and that no manifest entry has drifted.
 */
export function validateOwnership(projectDir: string): OwnershipResult {
  const manifest = readManifest(projectDir);

  // If there is no manifest, every file on disk is an orphan.
  if (!manifest) {
    const actualFiles = readActualFiles(projectDir);
    return {
      owned: actualFiles.length === 0,
      orphanCount: actualFiles.length,
      missingCount: 0,
      unexpectedEdits: [],
    };
  }

  // 1. Build expected file map from manifest
  const expectedFiles = buildExpectedFileMap(manifest);

  // 2. Read actual files on disk
  const actualFiles = readActualFiles(projectDir);

  // 3. Compute orphans, missing, unexpected edits
  const expectedPaths = new Set(expectedFiles.keys());
  const actualPaths = new Set(actualFiles);

  const orphans: string[] = [];
  for (const f of actualFiles) {
    if (!expectedPaths.has(f)) {
      orphans.push(f);
    }
  }

  const missing: string[] = [];
  for (const f of expectedPaths) {
    if (!actualPaths.has(f)) {
      missing.push(f);
    }
  }

  const unexpectedEdits: string[] = [];
  for (const f of actualFiles) {
    const expectedHash = expectedFiles.get(f);
    if (expectedHash) {
      const actualPath = resolve(projectDir, GENERATED_DIR, f);
      const actualHash = hashFile(actualPath);
      if (actualHash !== expectedHash) {
        unexpectedEdits.push(f);
      }
    }
  }

  return {
    owned: orphans.length === 0 && missing.length === 0 && unexpectedEdits.length === 0,
    orphanCount: orphans.length,
    missingCount: missing.length,
    unexpectedEdits,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of relative file path → expected SHA-256 hash from the manifest.
 * Paths are normalized to be relative to `contract/generated/` so they match
 * the output of `readActualFiles()`.
 */
function buildExpectedFileMap(
  manifest: GenerationManifest,
): Map<string, string> {
  const fileMap = new Map<string, string>();
  const entries = extractGeneratedFiles(manifest);

  for (const entry of entries) {
    // Normalize: strip the GENERATED_DIR prefix if present,
    // so paths match the format returned by readActualFiles().
    // e.g. "contract/generated/ddd-typedriven.stele" → "ddd-typedriven.stele"
    const normalized = stripGeneratedPrefix(entry.path);
    fileMap.set(normalized, entry.hash);
  }

  return fileMap;
}

/**
 * Strip the `contract/generated/` prefix from a path.
 */
function stripGeneratedPrefix(path: string): string {
  const posix = path.replace(/\\/g, "/");
  if (posix.startsWith(GENERATED_DIR + "/")) {
    return posix.slice((GENERATED_DIR + "/").length);
  }
  return posix;
}

function extractGeneratedFiles(manifest: GenerationManifest): GeneratedFileEntry[] {
  if (manifest.generatedFiles && manifest.generatedFiles.length > 0) {
    return manifest.generatedFiles;
  }

  // Legacy fallback: manifests without generatedFiles cannot validate ownership.
  return [];
}

function readActualFiles(projectDir: string): string[] {
  const dirPath = resolve(projectDir, GENERATED_DIR);
  const files: string[] = [];
  try {
    const st = statSync(dirPath);
    if (!st.isDirectory()) return [];
    walkDir(dirPath, dirPath, files);
  } catch {
    // Directory doesn't exist — no files
  }
  return files.sort();
}

function walkDir(dir: string, baseDir: string, result: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walkDir(resolve(dir, entry.name), baseDir, result);
      } else if (entry.isFile()) {
        const fullPath = resolve(dir, entry.name);
        const rel = relative(baseDir, fullPath);
        result.push(rel.replace(/\\/g, "/"));
      }
    }
  } catch {
    // Ignore unreadable directories
  }
}
