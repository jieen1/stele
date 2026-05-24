import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { posix, win32 } from "node:path";
import {
  CORE_OPERATOR_SPECS,
  buildTransitiveHash,
  coordinateGeneration,
  hashManifestSha256,
  loadContract,
  normalizeFile,
  posixNormalize,
  readHashManifest,
  sha256OfFileOrNull,
  stableStringCompare,
  stableStringify,
  stripVolatileConfigFields,
  writeAtomic,
  writeHashManifest,
  type Contract,
  type ContractFile,
  type FileEntry,
  type GeneratedVerificationResult,
  type HashManifest,
  type LanguageBackend,
  type ParsedFileLike,
} from "@stele/core";
import globParent from "glob-parent";
import { minimatch } from "minimatch";
import { SteleError } from "@stele/core";
import { loadBackend } from "../backend-registry.js";
import { STELE_BASELINE_FILE } from "../config/defaults.js";
import { loadConfig } from "../config/loadConfig.js";
import { CliCommandError, getExitCode } from "../errors.js";
import { discoverProjects } from "../recursive-discovery.js";
import { isMissingFileError, isAbsoluteLikePath } from "../utils/shared-utils.js";
import { aggregateExitCode, formatRecursiveHeader, formatRecursiveSummary, type SubReport } from "./recursive.js";

import { STELE_VERSION } from "../version.js";

export type GenerateOptions = {
  force?: boolean;
  noCache?: boolean;
  recursive?: boolean;
  json?: boolean;
};

export type GenerateSummary = {
  generatedDir: string;
  generatedFileCount: number;
  written: number;
  skipped: number;
  deleted: number;
  fullInvalidate: boolean;
  cacheUsed: boolean;
};

export type RecursiveGenerateResult = {
  exitCode: number;
  subReports: SubReport[];
  jsonOutput?: string;
};

type ProtectedPathOptions = {
  protected: string[];
  manifestPath: string;
  generatedDir: string;
  checkerImplDir: string;
  entry: string;
};

export async function runGenerate(projectDir: string, options: GenerateOptions): Promise<GenerateSummary> {
  const absoluteProjectDir = resolve(projectDir);
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const preGeneratedProtectedPaths = await collectProtectedPaths(projectDir, config);

  await assertProtectedContractFilesReachable(projectDir, config.entry, preGeneratedProtectedPaths, contract);

  const backend = await loadBackend(config.targetLanguage, config.testFramework);
  const verification = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  // EP05: drift check is cache-aware. If a "changed" file matches the cache's
  // record of what we last wrote, treat it as a legitimate source-driven update
  // (not external tampering). Same for "extra" files we previously wrote.
  const cachePeek = options.noCache ? null : await readHashManifest(absoluteProjectDir);
  const driftIsExternal = await isDriftExternalToCache(verification, cachePeek, absoluteProjectDir);

  if (!options.force && driftIsExternal) {
    throw new CliCommandError(formatGeneratedDriftMessage(verification), 2);
  }

  if (options.force) {
    await Promise.all(verification.extra.map((path) => rm(join(projectDir, path), { recursive: true, force: true })));
  }

  const generatedFiles = coordinateGeneration(contract, backend, {
    projectRoot: projectDir,
    outputDir: config.generatedDir,
  });

  // EP05: incremental generation. Reuses the cache peeked above for drift detection.
  const cached = cachePeek;

  const currentConfigHash = hashManifestSha256(
    stableStringify(stripVolatileConfigFields(config as unknown as Record<string, unknown>)),
  );
  const currentBackendName = backend.name;
  const currentSteleVersion = STELE_VERSION;
  const currentOperatorRegistryHash = hashManifestSha256(stableStringify(CORE_OPERATOR_SPECS));

  const fullInvalidate =
    options.force === true ||
    cached === null ||
    cached.version !== "1" ||
    cached.config_hash !== currentConfigHash ||
    cached.backend !== currentBackendName ||
    cached.stele_version !== currentSteleVersion ||
    cached.operator_registry_hash !== currentOperatorRegistryHash;

  let writtenCount = 0;
  let skippedCount = 0;
  const newOutputHashes: Record<string, string> = {};

  for (const file of generatedFiles) {
    const normalizedPath = posixNormalize(file.path);
    const newHash = hashManifestSha256(file.content);
    newOutputHashes[normalizedPath] = newHash;

    const absoluteOutputPath = join(absoluteProjectDir, file.path);

    if (fullInvalidate) {
      await writeAtomic(absoluteOutputPath, file.content);
      writtenCount++;
      continue;
    }

    const oldHash = cached?.output_hashes_global?.[normalizedPath];
    if (oldHash === newHash) {
      const onDisk = await sha256OfFileOrNull(absoluteOutputPath);
      if (onDisk === oldHash) {
        skippedCount++;
        continue;
      }
    }

    await writeAtomic(absoluteOutputPath, file.content);
    writtenCount++;
  }

  // Delete stale outputs (cached entries no longer in generatedFiles).
  const generatedPathSet = new Set(generatedFiles.map((file) => posixNormalize(file.path)));
  let deletedCount = 0;
  if (cached !== null) {
    const stalePaths = new Set<string>();
    for (const cachedPath of Object.keys(cached.output_hashes_global ?? {})) {
      if (!generatedPathSet.has(cachedPath)) {
        stalePaths.add(cachedPath);
      }
    }

    for (const stalePath of stalePaths) {
      const absoluteStalePath = join(absoluteProjectDir, stalePath);
      try {
        await unlink(absoluteStalePath);
        deletedCount++;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }
  }

  if (!options.noCache) {
    const newFileEntries = await buildHashManifestFileEntries(absoluteProjectDir, contract);
    const manifest: HashManifest = {
      version: "1",
      generated_at: new Date().toISOString(),
      stele_version: currentSteleVersion,
      backend: currentBackendName,
      operator_registry_hash: currentOperatorRegistryHash,
      config_hash: currentConfigHash,
      files: newFileEntries,
      output_hashes_global: newOutputHashes,
    };

    await writeHashManifest(absoluteProjectDir, manifest);
  }

  return {
    generatedDir: config.generatedDir,
    generatedFileCount: generatedFiles.length,
    written: writtenCount,
    skipped: skippedCount,
    deleted: deletedCount,
    fullInvalidate,
    cacheUsed: !options.noCache,
  };
}

async function buildHashManifestFileEntries(
  absoluteProjectDir: string,
  contract: Contract,
): Promise<Record<string, FileEntry>> {
  const filesByRelativePath = new Map<string, ParsedFileLike>();
  const dag = new Map<string, string[]>();

  for (const file of contract.files) {
    const relativePath = posixNormalize(relative(absoluteProjectDir, file.path));
    const importDeps = file.imports
      .map((declaration) => posixNormalize(relative(absoluteProjectDir, declaration.resolvedPath)))
      .sort((left, right) => stableStringCompare(left, right));

    filesByRelativePath.set(relativePath, {
      relativePath,
      absolutePath: file.path,
      normalized: normalizeFile(file as ContractFile),
      deps: importDeps,
    });

    dag.set(relativePath, importDeps);
  }

  const transitiveHashes = buildTransitiveHash(filesByRelativePath, dag);
  const entries: Record<string, FileEntry> = {};

  for (const [relativePath, file] of filesByRelativePath.entries()) {
    const transitiveHash = transitiveHashes.get(relativePath);
    if (transitiveHash === undefined) {
      throw new SteleError(
        "E_HASH_MANIFEST_MISSING_TRANSITIVE_HASH",
        "GenerateError",
        `Failed to compute transitive_hash for "${relativePath}".`,
        undefined,
        undefined,
        "This indicates an internal inconsistency between contract.files and the import DAG.",
      );
    }

    entries[relativePath] = {
      own_hash: hashManifestSha256(file.normalized),
      transitive_hash: transitiveHash,
      deps: file.deps,
      output_paths: [],
      output_hashes: {},
    };
  }

  return entries;
}

/**
 * Run `stele generate` across every project found under `rootDir` (recursive mode).
 *
 * Discovers all `stele.config.json` files, sorts deterministically, and runs
 * single-project `runGenerate` on each (with `--recursive` removed). Per
 * EP08 spec: any sub-project exit 1 → total 1; otherwise max of remaining
 * non-zero codes.
 */
export async function runGenerateRecursive(
  rootDir: string,
  options: GenerateOptions,
  output: { stdout: (chunk: string) => void; stderr: (chunk: string) => void },
): Promise<RecursiveGenerateResult> {
  const projects = await discoverProjects(rootDir);

  if (projects.length === 0) {
    throw new SteleError(
      "E_NO_PROJECTS_FOUND",
      "RecursiveError",
      `No stele.config.json found under ${rootDir}. Run 'stele init' in a sub-directory first.`,
      undefined,
      undefined,
      "Run 'stele init' in a sub-directory or change to a directory containing Stele projects.",
    );
  }

  if (!options.json) {
    output.stdout(formatRecursiveHeader(projects));
  }

  const subReports: SubReport[] = [];
  const subOptions: GenerateOptions = { ...options, recursive: false, json: false };

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    const indexLabel = `[${i + 1}/${projects.length}]`;

    if (!options.json) {
      output.stdout(`${indexLabel} generating ${project}\n`);
    }

    const subReport = await runSingleProjectGenerate(project, subOptions);
    subReports.push(subReport);

    if (!options.json) {
      const status =
        subReport.exit_code === 0
          ? `  generated ${subReport.summary.generated_file_count ?? 0} file${subReport.summary.generated_file_count === 1 ? "" : "s"}`
          : `  failed (exit ${subReport.exit_code})${subReport.error ? `: ${subReport.error.message}` : ""}`;
      output.stdout(`${status}\n\n`);
    }
  }

  const exitCode = aggregateExitCode(subReports);

  if (options.json) {
    const passed = subReports.filter((report) => report.exit_code === 0).length;
    const failed = subReports.length - passed;
    const aggregate = {
      schema_version: "1" as const,
      tool: "@stele/cli",
      command: "generate",
      generated_at: new Date().toISOString(),
      cwd: rootDir,
      projects: subReports,
      max_exit_code: exitCode,
      passed,
      failed,
    };
    const jsonOutput = `${JSON.stringify(aggregate, null, 2)}\n`;
    output.stdout(jsonOutput);
    return { exitCode, subReports, jsonOutput };
  }

  output.stdout(formatRecursiveSummary(subReports));
  return { exitCode, subReports };
}

async function runSingleProjectGenerate(projectDir: string, options: GenerateOptions): Promise<SubReport> {
  try {
    const result = await runGenerate(projectDir, options);
    return {
      project: projectDir,
      exit_code: 0,
      summary: {
        generated_file_count: result.generatedFileCount,
      },
    };
  } catch (error) {
    const exitCode = getExitCode(error) ?? 1;
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof SteleError ? error.code : undefined;
    return {
      project: projectDir,
      exit_code: exitCode,
      summary: { generated_file_count: 0 },
      error: { message, code },
    };
  }
}

/**
 * Determine whether the verification's drift comes from an external party (a
 * user editing generated files manually) or from a legitimate source-driven
 * regeneration that the cache witnessed previously.
 *
 * Returns `true` when the drift is external (and should block); `false` when
 * the cache contains a record of the drifting file's previous on-disk hash
 * matching what's currently there (i.e., we wrote it last time, the user then
 * edited the source, and we now want to overwrite it with the new generation).
 */
async function isDriftExternalToCache(
  verification: { changed: string[]; extra: string[] },
  cached: HashManifest | null,
  absoluteProjectDir: string,
): Promise<boolean> {
  if (cached === null) {
    return verification.changed.length > 0 || verification.extra.length > 0;
  }

  const witnesses = cached.output_hashes_global ?? {};
  const driftCandidates = [...verification.changed, ...verification.extra];

  for (const relativePath of driftCandidates) {
    const normalized = posixNormalize(relativePath);
    const expectedHash = witnesses[normalized];
    if (expectedHash === undefined) {
      // Cache has no record of this file; it's truly external drift.
      return true;
    }
    const actualHash = await sha256OfFileOrNull(join(absoluteProjectDir, relativePath));
    if (actualHash !== expectedHash) {
      // On-disk content has been modified since we last wrote it: external drift.
      return true;
    }
  }

  // Every drifting file's on-disk content matches what the cache says we wrote.
  // This is a legitimate source-driven regeneration; allow it.
  return false;
}

export async function collectProtectedPaths(projectDir: string, options: ProtectedPathOptions): Promise<string[]> {
  const normalizedProjectRoot = resolve(projectDir);
  const normalizedManifestPath = resolve(projectDir, options.manifestPath);
  const normalizedBaselinePath = resolve(projectDir, STELE_BASELINE_FILE);
  const matchedPaths = new Set<string>();

  for (const protectedPattern of options.protected) {
    const normalizedPattern = normalizeProtectedPattern(protectedPattern);
    const matches = await expandProtectedPattern(normalizedProjectRoot, normalizedPattern);

    for (const projectRelativePath of matches) {
      const absolutePath = resolve(normalizedProjectRoot, projectRelativePath);

      if (absolutePath === normalizedManifestPath) {
        continue;
      }

      if (absolutePath === normalizedBaselinePath) {
        // Exclude .baseline.json from manifest: it's a control-plane file
        // tracked by git, not a file whose fingerprint should be hashed.
        // Its integrity is verified by the baseline's human_state section.
        continue;
      }

      if (isIgnoredProtectedArtifact(projectRelativePath, options.generatedDir, options.checkerImplDir)) {
        continue;
      }

      matchedPaths.add(absolutePath);
    }
  }

  return uniqueSortedPaths([...matchedPaths]);
}

export async function verifyManagedGeneratedFiles(
  projectDir: string,
  generatedDir: string,
  contract: Contract,
  backend: LanguageBackend,
): Promise<GeneratedVerificationResult> {
  const { verifyGenerated } = await import("@stele/core");
  const verification = await verifyGenerated(contract, backend, {
    projectRoot: projectDir,
    outputDir: generatedDir,
  });
  const allowedExtras = new Set([posix.join(generatedDir, "conftest.py")]);
  const files = verification.files.filter(
    (file) => !(file.status === "extra" && (allowedExtras.has(file.path) || isIgnoredGeneratedArtifact(file.path, generatedDir))),
  );
  const extra = verification.extra.filter((path) => !allowedExtras.has(path) && !isIgnoredGeneratedArtifact(path, generatedDir));
  const changed = files.filter((file) => file.status === "changed").map((file) => file.path);
  const missing = files.filter((file) => file.status === "missing").map((file) => file.path);
  const unchanged = files.filter((file) => file.status === "unchanged").map((file) => file.path);

  return {
    ...verification,
    ok: missing.length === 0 && changed.length === 0 && extra.length === 0,
    files,
    unchanged,
    missing,
    changed,
    extra,
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function toManifestPaths(projectDir: string, protectedPaths: string[]): string[] {
  const normalizedProjectRoot = resolve(projectDir);

  return protectedPaths
    .map((path) => normalizeProjectRelativePath(normalizedProjectRoot, path))
    .sort((left, right) => stableStringCompare(left, right));
}

export async function assertProtectedContractFilesReachable(
  projectDir: string,
  entryPath: string,
  protectedPaths: string[],
  contract: Contract,
): Promise<void> {
  const loadedContractFiles = new Set(
    await Promise.all(contract.files.map(async (file) => canonicalizeContractPath(resolve(file.path)))),
  );
  const unresolvedProtectedContractFiles: string[] = [];

  for (const path of protectedPaths.filter((candidatePath) => candidatePath.toLowerCase().endsWith(".stele"))) {
    const canonicalPath = await canonicalizeContractPath(resolve(path));

    if (!loadedContractFiles.has(canonicalPath)) {
      unresolvedProtectedContractFiles.push(path);
    }
  }

  if (unresolvedProtectedContractFiles.length === 0) {
    return;
  }

  throw new Error(
    `Protected contract files must be reachable from entry "${entryPath}". Import them into the contract entry graph before generating, checking, or locking. Files: ${toManifestPaths(projectDir, unresolvedProtectedContractFiles).join(", ")}.`,
  );
}

async function expandProtectedPattern(projectDir: string, pattern: string): Promise<string[]> {
  // Fast path: literal file paths (no glob metachars) — don't walk an entire
  // directory tree just to find one named file. Without this, a pattern like
  // `stele.config.json` triggers a full project-root walk via globParent()=='.',
  // which then crashes on any symlink under node_modules (Round 3 Reviewer G
  // P0 follow-up). For literal paths, just stat the candidate and return it
  // if the file exists and is a regular file.
  if (!containsGlobMetachars(pattern)) {
    const absolutePath = resolve(projectDir, pattern);
    try {
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(
          `Protected file scanning does not allow symbolic links or other non-regular entries: ${pattern}.`,
        );
      }
      if (!entryStat.isFile()) {
        return [];
      }
      return [pattern];
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
  }

  const rootPattern = normalizeProtectedPattern(globParent(pattern));
  const rootDirectory = rootPattern === "." ? projectDir : resolve(projectDir, rootPattern);
  const files = await walkProtectedRoot(rootDirectory, projectDir);

  return files.filter((file) => minimatch(file, pattern, { dot: true }));
}

function containsGlobMetachars(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

// Round 4 E-09 follow-up: package-scoped globs like `packages/*/tsup.config.ts`
// resolve globParent → "packages", which causes the walker to recurse into
// every package's node_modules (which often contains symlinks → throw).
// These directories are never source-of-truth for protected patterns and
// should be skipped wholesale by the walker.
const _PROTECTED_WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".pnpm-store",
  ".pnpm",
  ".cache",
  "dist",
  "coverage",
  // Round 6 M-04: skip ephemeral pytest cache. `.pytest_cache/` only
  // ever contains pytest-managed state (nodeids cache, run history),
  // never user source — wholesale skip is safe.
  ".pytest_cache",
]);

// Round 7 M-04 follow-up: `__pycache__/` USUALLY holds only `.pyc`/`.pyo`
// bytecode, but a malicious or naive user could place a real `.py` file
// inside it (and the test `generate does not ignore protected source
// files just because they live in __pycache__ directories` confirms we
// must track such files). So instead of skipping the whole directory,
// descend into it and only filter out the ephemeral compiled extensions
// on the file-suffix level below — via `isPythonCacheBasename`.

async function walkProtectedRoot(directory: string, projectDir: string): Promise<string[]> {
  try {
    const directoryStat = await stat(directory);

    if (!directoryStat.isDirectory()) {
      throw new Error(`Protected root "${normalizeProjectRelativePath(projectDir, directory)}" must be a directory.`);
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries
      .slice()
      .sort((left, right) => stableStringCompare(left.name, right.name))
      .map(async (entry) => {
        // Round 4 E-09: skip build / vendor / cache trees up front. The
        // glob matcher in the caller already filters against the requested
        // pattern, so the only thing recursion into these trees adds is
        // potential symlink-throws.
        if (_PROTECTED_WALK_SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const fullPath = join(directory, entry.name);
        const relativePath = normalizeProjectRelativePath(projectDir, fullPath);
        const entryStats = await lstat(fullPath);

        if (entryStats.isSymbolicLink()) {
          throw new Error(`Protected file scanning does not allow symbolic links or other non-regular entries: ${relativePath}.`);
        }

        if (entry.isDirectory()) {
          return walkProtectedRoot(fullPath, projectDir);
        }

        if (entry.isFile()) {
          // Round 7: filter ephemeral `.pyc`/`.pyo` regardless of
          // directory — they are always rewritten by the interpreter
          // and would churn the manifest on every test run.
          // Round 9 O-05: route through the single `isPythonCacheBasename`
          // helper so this code path and the generated-drift-comparison
          // ignore-list cannot disagree on what counts as a cache
          // artifact.
          if (isPythonCacheBasename(entry.name)) {
            return [];
          }
          return [relativePath];
        }

        throw new Error(`Protected file scanning does not allow non-regular entries: ${relativePath}.`);
      }),
  );

  return results.flat();
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].sort(
    (left, right) => stableStringCompare(normalizeForSort(left), normalizeForSort(right)),
  );
}

function normalizeForSort(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function normalizeProjectRelativePath(projectDir: string, absolutePath: string): string {
  return relative(projectDir, absolutePath).replaceAll("\\", "/");
}

function normalizeProtectedPattern(pattern: string): string {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("Protected patterns must be non-empty project-relative globs.");
  }

  if (isAbsoluteLikePath(pattern)) {
    throw new Error(`Protected pattern "${pattern}" must stay project-relative.`);
  }

  const normalized = win32
    .normalize(pattern)
    .split(win32.sep)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .reduce<string>((current, segment) => (current.length === 0 ? segment : posix.join(current, segment)), "");
  const normalizedPattern = normalized.length === 0 ? "." : normalized;

  if (normalizedPattern.split("/").includes("..")) {
    throw new Error(`Protected pattern "${pattern}" must stay inside the project root.`);
  }

  return normalizedPattern;
}

function isIgnoredProtectedArtifact(projectRelativePath: string, generatedDir: string, checkerImplDir: string): boolean {
  return (
    isIgnoredArtifactWithinBase(projectRelativePath, generatedDir) || isIgnoredArtifactWithinBase(projectRelativePath, checkerImplDir)
  );
}

function isIgnoredArtifactWithinBase(projectRelativePath: string, baseDirectory: string): boolean {
  const normalizedPath = projectRelativePath.replaceAll("\\", "/");
  const normalizedBase = baseDirectory.replaceAll("\\", "/");

  if (normalizedPath === normalizedBase) {
    return false;
  }

  if (!normalizedPath.startsWith(`${normalizedBase}/`)) {
    return false;
  }

  return isIgnoredPythonCacheArtifact(normalizedPath.slice(normalizedBase.length + 1));
}

function isIgnoredGeneratedArtifact(projectRelativePath: string, generatedDir: string): boolean {
  const normalizedPath = projectRelativePath.replaceAll("\\", "/");
  const normalizedGeneratedDir = generatedDir.replaceAll("\\", "/");

  if (!normalizedPath.startsWith(`${normalizedGeneratedDir}/`)) {
    return false;
  }

  return isIgnoredPythonCacheArtifact(normalizedPath.slice(normalizedGeneratedDir.length + 1));
}

function isIgnoredPythonCacheArtifact(path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const basename = segments[segments.length - 1] ?? "";
  return isPythonCacheBasename(basename);
}

// Round 9 O-05: single source of truth for "is this a Python cache
// artifact filename?". The protected-walk filter and the
// drift-comparison ignore-list previously had divergent case
// sensitivity (one lowercased, one did not). Both now route through
// this helper so a `foo.PYC` on a case-preserving filesystem is
// treated consistently across the two code paths.
export function isPythonCacheBasename(basename: string): boolean {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  const ext = basename.slice(dot).toLowerCase();
  return ext === ".pyc" || ext === ".pyo";
}

function formatGeneratedDriftMessage(verification: GeneratedVerificationResult): string {
  return [
    "Generated files differ from the canonical layout.",
    `Missing: ${verification.missing.join(", ") || "<none>"}.`,
    `Changed: ${verification.changed.join(", ") || "<none>"}.`,
    `Extra: ${verification.extra.join(", ") || "<none>"}.`,
    "Re-run stele generate --force to replace them.",
  ].join(" ");
}

async function canonicalizeContractPath(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  const canonicalPath = await realpath(resolvedPath).catch(() => resolvedPath);
  return process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
}
