import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { posix, win32 } from "node:path";
import {
  coordinateGeneration,
  loadContract,
  normalizeContract,
  type Contract,
  type GeneratedVerificationResult,
  type LanguageBackend,
} from "@stele/core";
import { generatePytestSource, getPythonRuntimeSource, sanitizePythonIdentifier } from "@stele/backend-python";
import globParent from "glob-parent";
import { minimatch } from "minimatch";
import { loadConfig } from "../config/loadConfig.js";

export type GenerateOptions = {
  force?: boolean;
};

type ProtectedPathOptions = {
  protected: string[];
  manifestPath: string;
  generatedDir: string;
  checkerImplDir: string;
  entry: string;
};

export async function runGenerate(projectDir: string, options: GenerateOptions): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const preGeneratedProtectedPaths = await collectProtectedPaths(projectDir, config);

  await assertProtectedContractFilesReachable(projectDir, config.entry, preGeneratedProtectedPaths, contract);

  const backend = createLanguageBackend(config.generatedDir, config.targetLanguage, config.testFramework);
  const verification = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  if (!options.force && (verification.changed.length > 0 || verification.extra.length > 0)) {
    throw new Error("Generated files differ from the canonical layout. Re-run stele generate --force to replace them.");
  }

  if (options.force) {
    await Promise.all(verification.extra.map((path) => rm(join(projectDir, path), { recursive: true, force: true })));
  }

  const generatedFiles = coordinateGeneration(contract, backend, {
    projectRoot: projectDir,
    outputDir: config.generatedDir,
  });

  await Promise.all(
    generatedFiles.map(async (file) => {
      const fullPath = join(projectDir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf8");
    }),
  );

}

export function createLanguageBackend(generatedDir: string, targetLanguage: string, testFramework: string): LanguageBackend {
  if (targetLanguage !== "python") {
    throw new Error(`Unsupported target language "${targetLanguage}".`);
  }

  if (testFramework !== "pytest") {
    throw new Error(`Unsupported test framework "${testFramework}".`);
  }

  return {
    name: "python",
    framework: "pytest",
    fileExtension: ".py",
    version: "0.1.0",
    generate(contract) {
      const files = [
        {
          path: posix.join(generatedDir, "_stele_runtime.py"),
          content: getPythonRuntimeSource(),
        },
      ];
      const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);

      if (topLevelInvariants.length > 0) {
        files.push({
          path: posix.join(generatedDir, "test_contract.py"),
          content: generatePytestSource({
            ...contract,
            invariants: topLevelInvariants,
          }),
        });
      }

      for (const group of contract.groups) {
        files.push({
          path: posix.join(generatedDir, `test_${sanitizePythonIdentifier(group.id, "group")}.py`),
          content: generatePytestSource({
            ...contract,
            invariants: group.invariants,
          }),
        });
      }

      return files;
    },
    supportFiles() {
      return [
        {
          path: posix.join(generatedDir, "__init__.py"),
          content: "",
        },
      ];
    },
  };
}

export async function collectProtectedPaths(projectDir: string, options: ProtectedPathOptions): Promise<string[]> {
  const normalizedProjectRoot = resolve(projectDir);
  const normalizedManifestPath = resolve(projectDir, options.manifestPath);
  const matchedPaths = new Set<string>();

  for (const protectedPattern of options.protected) {
    const normalizedPattern = normalizeProtectedPattern(protectedPattern);
    const matches = await expandProtectedPattern(normalizedProjectRoot, normalizedPattern);

    for (const projectRelativePath of matches) {
      const absolutePath = resolve(normalizedProjectRoot, projectRelativePath);

      if (absolutePath === normalizedManifestPath) {
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
    .sort((left, right) => left.localeCompare(right));
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
  const rootPattern = normalizeProtectedPattern(globParent(pattern));
  const rootDirectory = rootPattern === "." ? projectDir : resolve(projectDir, rootPattern);
  const files = await walkProtectedRoot(rootDirectory, projectDir);

  return files.filter((file) => minimatch(file, pattern, { dot: true, windowsPathsNoEscape: true }));
}

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
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
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
          return [relativePath];
        }

        throw new Error(`Protected file scanning does not allow non-regular entries: ${relativePath}.`);
      }),
  );

  return results.flat();
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].sort((left, right) => normalizeForSort(left).localeCompare(normalizeForSort(right)));
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

  if (isAbsoluteLikePattern(pattern)) {
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

function isAbsoluteLikePattern(pattern: string): boolean {
  return posix.isAbsolute(pattern) || win32.isAbsolute(pattern) || /^[A-Za-z]:(?![\\/])/.test(pattern);
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

  return basename.endsWith(".pyc") || basename.endsWith(".pyo");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonicalizeContractPath(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  const canonicalPath = await realpath(resolvedPath).catch(() => resolvedPath);
  return process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
}
