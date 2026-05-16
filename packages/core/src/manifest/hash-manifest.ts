import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isMissingFileError } from "../util/fs.js";
import { SteleError } from "../errors/SteleError.js";
import { isPlainRecord } from "../util/types.js";

/**
 * EP05: Incremental generation hash manifest.
 *
 * `contract/.cache/hash-manifest.json` records per-file `transitive_hash`
 * (own normalized hash plus sorted hashes of imports' transitive_hash) along
 * with a global map of generated output paths to SHA-256 of their content.
 * `stele generate` reads this on each run and skips writing files whose
 * generated content hash matches the cached entry and the on-disk file.
 *
 * See `docs/design/phase-1/05-incremental-generation.md` §3 (schema) and §4
 * (algorithm).
 */
export const HASH_MANIFEST_VERSION = "1";
export const HASH_MANIFEST_RELATIVE_DIR = "contract/.cache";
export const HASH_MANIFEST_RELATIVE_PATH = "contract/.cache/hash-manifest.json";

export type FileEntry = {
  /** SHA-256 of `normalizeFile(parsedContractFile)` — invariant under
   *  whitespace and source-order rewrites. */
  own_hash: string;
  /** SHA-256(own_hash || sort(deps' transitive_hash).join("|")) — propagates
   *  changes through the import DAG so dependants invalidate when imports
   *  change. */
  transitive_hash: string;
  /** Sorted relative paths of direct imports (POSIX-normalized). */
  deps: string[];
  /** Reserved for v0.5+ per-file output attribution. v0.2 leaves empty since
   *  generation runs over the whole contract. */
  output_paths: string[];
  /** Reserved for v0.5+ per-file output hashes. v0.2 stores hashes globally
   *  on `HashManifest.output_hashes_global`. */
  output_hashes: Record<string, string>;
};

export type HashManifest = {
  version: typeof HASH_MANIFEST_VERSION;
  generated_at: string;
  stele_version: string;
  backend: string;
  operator_registry_hash: string;
  config_hash: string;
  files: Record<string, FileEntry>;
  output_hashes_global: Record<string, string>;
};

export type ParsedFileLike = {
  /** POSIX-normalized project-relative path (cache key). */
  relativePath: string;
  /** Absolute path used for DAG lookup. */
  absolutePath: string;
  /** Output of `normalizeFile(file)` from `@stele/core`. */
  normalized: string;
  /** Sorted POSIX-normalized project-relative paths of direct imports. */
  deps: string[];
};

export async function readHashManifest(projectRoot: string): Promise<HashManifest | null> {
  const cachePath = join(resolve(projectRoot), HASH_MANIFEST_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await readFile(cachePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted JSON → behave as if no cache (per design §4 step 1).
    return null;
  }

  if (!isHashManifest(parsed)) {
    return null;
  }

  return parsed;
}

export async function writeHashManifest(projectRoot: string, manifest: HashManifest): Promise<void> {
  const absoluteRoot = resolve(projectRoot);
  const cachePath = join(absoluteRoot, HASH_MANIFEST_RELATIVE_PATH);
  await writeAtomic(cachePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function deleteHashManifest(projectRoot: string): Promise<boolean> {
  const cachePath = join(resolve(projectRoot), HASH_MANIFEST_RELATIVE_PATH);
  try {
    await unlink(cachePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

/**
 * Compute `transitive_hash` for every file in topological order (deps first).
 *
 * Inputs are POSIX-normalized project-relative paths. The DAG must be
 * acyclic — `loadContract` already enforces this (E0203). Throws on cycle as
 * defensive guard (`SteleError` with `E_TRANSITIVE_HASH_CYCLE`).
 */
export function buildTransitiveHash(
  files: Map<string, ParsedFileLike>,
  dag: Map<string, string[]>,
): Map<string, string> {
  const ownHashes = new Map<string, string>();
  for (const [path, file] of files.entries()) {
    ownHashes.set(path, sha256(file.normalized));
  }

  const order = topologicalSort(files, dag);
  const result = new Map<string, string>();

  for (const path of order) {
    const own = ownHashes.get(path);
    if (own === undefined) {
      throw new SteleError(
        "E_TRANSITIVE_HASH_MISSING_FILE",
        "HashManifest",
        `buildTransitiveHash: missing own hash for "${path}".`,
        undefined,
        "DAG referenced a file that was not present in the files map.",
        "Ensure the DAG and files map are derived from the same contract load.",
      );
    }

    const dependencies = dag.get(path) ?? [];
    const depHashes: string[] = [];
    for (const dependency of dependencies) {
      const transitive = result.get(dependency);
      if (transitive === undefined) {
        throw new SteleError(
          "E_TRANSITIVE_HASH_MISSING_DEP",
          "HashManifest",
          `buildTransitiveHash: dependency "${dependency}" of "${path}" is not in the DAG.`,
          undefined,
          "Each declared dependency must appear as its own DAG node.",
          "Verify DAG construction in the caller.",
        );
      }
      depHashes.push(transitive);
    }

    depHashes.sort();
    const transitive = sha256(`${own}|${depHashes.join("|")}`);
    result.set(path, transitive);
  }

  return result;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const directory = dirname(targetPath);
  await mkdir(directory, { recursive: true });

  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmpPath, content, "utf8");

  try {
    await rename(tmpPath, targetPath);
  } catch (error) {
    // Windows: rename may fail if dest exists. Fallback: unlink existing,
    // then retry rename.
    if (isWindowsRenameError(error)) {
      try {
        await unlink(targetPath);
      } catch (unlinkError) {
        if (!isMissingFileError(unlinkError)) {
          await safeUnlink(tmpPath);
          throw unlinkError;
        }
      }

      try {
        await rename(tmpPath, targetPath);
        return;
      } catch (renameError) {
        await safeUnlink(tmpPath);
        throw renameError;
      }
    }

    await safeUnlink(tmpPath);
    throw error;
  }
}

export async function sha256OfFileOrNull(filePath: string): Promise<string | null> {
  try {
    const buffer = await readFile(filePath);
    return createHash("sha256").update(buffer).digest("hex");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

export function posixNormalize(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Strip volatile fields that should not invalidate the cache. */
export function stripVolatileConfigFields(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "_generated_at" || key === "generated_at") {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function topologicalSort(files: Map<string, ParsedFileLike>, dag: Map<string, string[]>): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  // Iterate deterministically by sorted key so the resulting order is stable
  // across runs.
  const sortedKeys = [...files.keys()].sort();

  const visit = (node: string, stack: string[]): void => {
    if (visited.has(node)) {
      return;
    }

    if (visiting.has(node)) {
      throw new SteleError(
        "E_TRANSITIVE_HASH_CYCLE",
        "HashManifest",
        `buildTransitiveHash: import cycle detected involving "${node}".`,
        undefined,
        [...stack, node].join(" -> "),
        "Break the cycle in the contract files; loadContract should have rejected it.",
      );
    }

    visiting.add(node);
    const dependencies = (dag.get(node) ?? []).slice().sort();

    for (const dependency of dependencies) {
      if (!files.has(dependency)) {
        // Dependency outside the contract files map (shouldn't happen for a
        // freshly-loaded contract but tolerated as a no-op so the caller
        // doesn't need to pre-validate).
        continue;
      }

      visit(dependency, [...stack, node]);
    }

    visiting.delete(node);
    visited.add(node);
    sorted.push(node);
  };

  for (const key of sortedKeys) {
    visit(key, []);
  }

  return sorted;
}

function isHashManifest(value: unknown): value is HashManifest {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (
    value.version !== HASH_MANIFEST_VERSION ||
    typeof value.generated_at !== "string" ||
    typeof value.stele_version !== "string" ||
    typeof value.backend !== "string" ||
    typeof value.operator_registry_hash !== "string" ||
    typeof value.config_hash !== "string" ||
    !isPlainRecord(value.files) ||
    !isPlainRecord(value.output_hashes_global)
  ) {
    return false;
  }

  if (!Object.values(value.output_hashes_global).every((entry) => typeof entry === "string")) {
    return false;
  }

  for (const fileEntry of Object.values(value.files)) {
    if (!isFileEntry(fileEntry)) {
      return false;
    }
  }

  return true;
}

function isFileEntry(value: unknown): value is FileEntry {
  if (!isPlainRecord(value)) {
    return false;
  }

  if (
    typeof value.own_hash !== "string" ||
    typeof value.transitive_hash !== "string" ||
    !Array.isArray(value.deps) ||
    !value.deps.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.output_paths) ||
    !value.output_paths.every((entry) => typeof entry === "string") ||
    !isPlainRecord(value.output_hashes)
  ) {
    return false;
  }

  return Object.values(value.output_hashes).every((entry) => typeof entry === "string");
}

function isWindowsRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM" || code === "EACCES";
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      // Best-effort cleanup: don't shadow the original failure.
    }
  }
}
