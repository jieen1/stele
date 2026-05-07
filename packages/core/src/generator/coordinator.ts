import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { posix, relative, resolve, win32 } from "node:path";
import { isMissingFileError } from "../util/fs.js";
import { SteleError } from "../errors/SteleError.js";
import type { Contract } from "../validator/structure.js";

export const DEFAULT_GENERATED_OUTPUT_DIR = "tests/contract";

export type GeneratedFile = {
  path: string;
  content: string;
};

export type GenerationConfig = {
  projectRoot: string;
  outputDir?: string;
};

export interface LanguageBackend {
  name: string;
  framework: string;
  fileExtension: string;
  version: string;
  generate(contract: Contract, config: GenerationConfig): GeneratedFile[];
  supportFiles?(contract: Contract, config: GenerationConfig): GeneratedFile[];
}

export type GeneratedVerificationStatus = "missing" | "changed" | "extra" | "unchanged";

export type GeneratedVerificationFile = {
  path: string;
  status: GeneratedVerificationStatus;
  expectedContent?: string;
  actualContent?: string;
};

export type GeneratedVerificationResult = {
  ok: boolean;
  outputDir: string;
  unchanged: string[];
  missing: string[];
  changed: string[];
  extra: string[];
  files: GeneratedVerificationFile[];
};

type ResolvedGenerationConfig = {
  projectRoot: string;
  outputDir: string;
};

type ExistingGeneratedEntry = {
  path: string;
  kind: "file" | "non-regular";
};

export function coordinateGeneration(contract: Contract, backend: LanguageBackend, config: GenerationConfig): GeneratedFile[] {
  const resolvedConfig = resolveGenerationConfig(config);
  const canonicalPaths = buildCanonicalGeneratedPaths(contract, backend, resolvedConfig);
  const generatedFiles = backend.generate(contract, resolvedConfig);
  const supportFiles = backend.supportFiles?.(contract, resolvedConfig) ?? [];

  if (!Array.isArray(generatedFiles)) {
    throw generationError(
      "E0501",
      `Backend "${backend.name}" returned an invalid generated file list.`,
      "Expected generate() to return an array of { path, content } objects.",
      "Return a deterministic array of generated files from the backend.",
    );
  }

  if (!Array.isArray(supportFiles)) {
    throw generationError(
      "E0501",
      `Backend "${backend.name}" returned an invalid support file list.`,
      "Expected supportFiles() to return an array of { path, content } objects.",
      "Return a deterministic array of generated support files from backend.supportFiles().",
    );
  }

  const normalizedSupportFiles = normalizeGeneratedFiles(supportFiles, resolvedConfig.outputDir);
  const expectedPaths = mergeExpectedGeneratedPaths(canonicalPaths, normalizedSupportFiles.map((file) => file.path));
  const normalizedFiles = normalizeGeneratedFiles([...generatedFiles, ...supportFiles], resolvedConfig.outputDir);
  assertGeneratedFilesMatchExpectedLayout(normalizedFiles, expectedPaths, backend.name);
  return normalizedFiles;
}

export async function verifyGenerated(
  contract: Contract,
  backend: LanguageBackend,
  config: GenerationConfig,
): Promise<GeneratedVerificationResult> {
  const resolvedConfig = resolveGenerationConfig(config);
  const expectedFiles = coordinateGeneration(contract, backend, resolvedConfig);
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file.content]));
  const actualEntries = await collectExistingGeneratedEntries(resolvedConfig.projectRoot, resolvedConfig.outputDir);
  const actualByPath = new Map<string, string>();
  const actualEntryKinds = new Map(actualEntries.map((entry) => [entry.path, entry.kind]));

  await Promise.all(
    actualEntries.map(async (entry) => {
      if (entry.kind !== "file") {
        actualByPath.set(entry.path, "[non-regular entry]");
        return;
      }

      actualByPath.set(entry.path, await readGeneratedFile(resolvedConfig.projectRoot, entry.path));
    }),
  );

  const files: GeneratedVerificationFile[] = [];

  for (const expectedFile of expectedFiles) {
    const actualContent = actualByPath.get(expectedFile.path);
    const actualKind = actualEntryKinds.get(expectedFile.path);

    if (actualContent === undefined) {
      files.push({
        path: expectedFile.path,
        status: "missing",
        expectedContent: expectedFile.content,
      });
      continue;
    }

    files.push({
      path: expectedFile.path,
      status: actualKind === "file" && actualContent === expectedFile.content ? "unchanged" : "changed",
      expectedContent: expectedFile.content,
      actualContent,
    });
  }

  for (const actualEntry of actualEntries) {
    if (expectedByPath.has(actualEntry.path)) {
      continue;
    }

    files.push({
      path: actualEntry.path,
      status: "extra",
      actualContent: actualByPath.get(actualEntry.path),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    ok: files.every((file) => file.status === "unchanged"),
    outputDir: resolvedConfig.outputDir,
    unchanged: files.filter((file) => file.status === "unchanged").map((file) => file.path),
    missing: files.filter((file) => file.status === "missing").map((file) => file.path),
    changed: files.filter((file) => file.status === "changed").map((file) => file.path),
    extra: files.filter((file) => file.status === "extra").map((file) => file.path),
    files,
  };
}

function resolveGenerationConfig(config: GenerationConfig): ResolvedGenerationConfig {
  if (typeof config.projectRoot !== "string" || config.projectRoot.length === 0) {
    throw generationError(
      "E0502",
      "Generation config requires a projectRoot.",
      "Expected projectRoot to be a non-empty filesystem path.",
      "Pass the repository or project root path when coordinating generation.",
    );
  }

  return {
    projectRoot: resolve(config.projectRoot),
    outputDir: normalizeRelativeDirectoryPath(config.outputDir ?? DEFAULT_GENERATED_OUTPUT_DIR, "generation output directory"),
  };
}

function buildCanonicalGeneratedPaths(
  contract: Contract,
  backend: LanguageBackend,
  config: ResolvedGenerationConfig,
): string[] {
  const expectedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const seenCaseFoldedPaths = new Map<string, string>();
  const fileExtension = normalizeFileExtension(backend.fileExtension);
  const topLevelInvariants = contract.invariants.filter((invariant) => invariant.groupId === undefined);
  const groupPaths = contract.groups.map((group) =>
    posix.join(config.outputDir, `test_${sanitizeGeneratedPathSegment(group.id, "group")}${fileExtension}`),
  );

  registerGeneratedPath(
    posix.join(config.outputDir, `_stele_runtime${fileExtension}`),
    seenPaths,
    seenCaseFoldedPaths,
    "canonical generated file path",
    (path) => expectedPaths.push(path),
  );

  if (topLevelInvariants.length > 0) {
    registerGeneratedPath(
      posix.join(config.outputDir, `test_contract${fileExtension}`),
      seenPaths,
      seenCaseFoldedPaths,
      "canonical generated file path",
      (path) => expectedPaths.push(path),
    );
  }

  for (const groupPath of groupPaths) {
    registerGeneratedPath(groupPath, seenPaths, seenCaseFoldedPaths, "canonical generated file path", (path) => expectedPaths.push(path));
  }

  expectedPaths.sort((left, right) => left.localeCompare(right));
  return expectedPaths;
}

function mergeExpectedGeneratedPaths(canonicalPaths: string[], supportPaths: string[]): string[] {
  const expectedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const seenCaseFoldedPaths = new Map<string, string>();

  for (const path of [...canonicalPaths, ...supportPaths]) {
    registerGeneratedPath(path, seenPaths, seenCaseFoldedPaths, "expected generated file path", (value) => expectedPaths.push(value));
  }

  expectedPaths.sort((left, right) => left.localeCompare(right));
  return expectedPaths;
}

function normalizeGeneratedFiles(files: GeneratedFile[], outputDir: string): GeneratedFile[] {
  const normalizedFiles: GeneratedFile[] = [];
  const seenPaths = new Set<string>();
  const seenCaseFoldedPaths = new Map<string, string>();

  for (const file of files) {
    if (!isGeneratedFile(file)) {
      throw generationError(
        "E0501",
        "Backend returned an invalid generated file entry.",
        "Each generated file must include string path and content fields.",
        "Return only objects shaped like { path, content } from backend.generate().",
      );
    }

    const normalizedPath = normalizeRelativeFilePath(file.path, "generated file path");
    assertPathWithinOutputDirectory(normalizedPath, outputDir);
    registerGeneratedPath(normalizedPath, seenPaths, seenCaseFoldedPaths, "generated file path", (path) =>
      normalizedFiles.push({
        path,
        content: file.content,
      }),
    );
  }

  normalizedFiles.sort((left, right) => left.path.localeCompare(right.path) || left.content.localeCompare(right.content));
  return normalizedFiles;
}

function assertGeneratedFilesMatchExpectedLayout(
  actualFiles: GeneratedFile[],
  expectedPaths: string[],
  backendName: string,
): void {
  const actualPaths = actualFiles.map((file) => file.path);
  const actualPathSet = new Set(actualPaths);
  const expectedPathSet = new Set(expectedPaths);
  const missing = expectedPaths.filter((path) => !actualPathSet.has(path));
  const unexpected = actualPaths.filter((path) => !expectedPathSet.has(path));

  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const detailLines = [
    `expected: ${expectedPaths.join(", ") || "<none>"}`,
    `missing: ${missing.join(", ") || "<none>"}`,
    `unexpected: ${unexpected.join(", ") || "<none>"}`,
  ];

  throw generationError(
    "E0505",
    `Backend "${backendName}" did not emit the canonical generated layout.`,
    detailLines.join("\n"),
    "Emit exactly the runtime helper plus the canonical top-level and group test files required by core.",
  );
}

async function collectExistingGeneratedEntries(projectRoot: string, outputDir: string): Promise<ExistingGeneratedEntry[]> {
  const outputDirectoryPath = resolve(projectRoot, outputDir);

  try {
    const directory = await stat(outputDirectoryPath);

    if (!directory.isDirectory()) {
      return [];
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }

  const entries = await walkGeneratedDirectory(outputDirectoryPath, projectRoot);
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return entries;
}

async function walkGeneratedDirectory(directoryPath: string, projectRoot: string): Promise<ExistingGeneratedEntry[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const results: ExistingGeneratedEntry[] = [];

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = resolve(directoryPath, entry.name);
    const pathOnDisk = normalizeRelativeFilePath(relative(projectRoot, fullPath), "generated disk path");
    const entryStats = await lstat(fullPath);

    if (entryStats.isSymbolicLink()) {
      results.push({
        path: pathOnDisk,
        kind: "non-regular",
      });
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...(await walkGeneratedDirectory(fullPath, projectRoot)));
      continue;
    }

    if (entry.isFile()) {
      results.push({
        path: pathOnDisk,
        kind: "file",
      });
      continue;
    }

    results.push({
      path: pathOnDisk,
      kind: "non-regular",
    });
  }

  return results;
}

async function readGeneratedFile(projectRoot: string, generatedPath: string): Promise<string> {
  return readFile(resolve(projectRoot, generatedPath), "utf8");
}

function assertPathWithinOutputDirectory(filePath: string, outputDir: string): void {
  const relativeToOutputDirectory = posix.relative(outputDir, filePath);

  if (
    relativeToOutputDirectory.length === 0 ||
    relativeToOutputDirectory === ".." ||
    relativeToOutputDirectory.startsWith("../") ||
    posix.isAbsolute(relativeToOutputDirectory)
  ) {
    throw generationError(
      "E0504",
      `Generated file path "${filePath}" is outside the configured output directory "${outputDir}".`,
      "Generated paths must stay project-relative and nested under the generated output directory.",
      `Emit files under "${outputDir}" only.`,
    );
  }
}

function normalizeRelativeDirectoryPath(pathValue: string, label: string): string {
  const normalized = normalizeRelativePath(pathValue, label);

  if (normalized === ".") {
    throw generationError(
      "E0502",
      `Invalid ${label} "${pathValue}".`,
      "The generated output directory must name a project-relative subdirectory.",
      `Use a path such as "${DEFAULT_GENERATED_OUTPUT_DIR}".`,
    );
  }

  return normalized;
}

function normalizeRelativeFilePath(pathValue: string, label: string): string {
  const normalized = normalizeRelativePath(pathValue, label);

  if (normalized === ".") {
    throw generationError(
      "E0504",
      `Invalid ${label} "${pathValue}".`,
      "Generated file paths must identify a file beneath the output directory.",
      "Provide a project-relative file path such as tests/contract/test_contract.py.",
    );
  }

  return normalized;
}

function normalizeFileExtension(fileExtension: string): string {
  if (typeof fileExtension !== "string" || !/^\.[A-Za-z0-9]+$/.test(fileExtension)) {
    throw generationError(
      "E0502",
      `Invalid backend file extension "${fileExtension}".`,
      "Expected a simple extension such as .py or .ts for canonical generated output.",
      "Set backend.fileExtension to a dot-prefixed extension without path separators.",
    );
  }

  return fileExtension;
}

function sanitizeGeneratedPathSegment(value: string, fallbackPrefix: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withFallback = sanitized.length === 0 ? fallbackPrefix : sanitized;
  return /^[0-9]/.test(withFallback) ? `${fallbackPrefix}_${withFallback}` : withFallback;
}

function normalizeRelativePath(pathValue: string, label: string): string {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw generationError(
      "E0502",
      `Invalid ${label}.`,
      `Expected ${label} to be a non-empty string.`,
      "Provide a project-relative path.",
    );
  }

  if (posix.isAbsolute(pathValue) || win32.isAbsolute(pathValue)) {
    throw generationError(
      "E0504",
      `Invalid ${label} "${pathValue}".`,
      "Absolute paths are not allowed for generated output.",
      "Use project-relative paths only.",
    );
  }

  const normalized = win32
    .normalize(pathValue)
    .split(win32.sep)
    .filter((segment) => segment.length > 0)
    .reduce<string>((currentPath, segment) => {
      if (currentPath.length === 0) {
        return segment;
      }

      return posix.join(currentPath, segment);
    }, "");
  const projectRelativePath = normalized.length === 0 ? "." : normalized;

  if (projectRelativePath === ".." || projectRelativePath.startsWith("../")) {
    throw generationError(
      "E0504",
      `Invalid ${label} "${pathValue}".`,
      "Parent-directory traversal is not allowed for generated output.",
      "Keep generated paths inside the configured output directory.",
    );
  }

  return projectRelativePath;
}

function registerGeneratedPath(
  normalizedPath: string,
  seenPaths: Set<string>,
  seenCaseFoldedPaths: Map<string, string>,
  label: string,
  register: (path: string) => void,
): void {
  if (seenPaths.has(normalizedPath)) {
    throw generationError(
      "E0503",
      `Duplicate ${label} "${normalizedPath}".`,
      "Generated file paths must be unique after normalization.",
      "Ensure each project-relative generated file path appears exactly once.",
    );
  }

  const caseFoldedPath = normalizedPath.toLowerCase();
  const collidingPath = seenCaseFoldedPaths.get(caseFoldedPath);

  if (collidingPath !== undefined && collidingPath !== normalizedPath) {
    throw generationError(
      "E0503",
      `Case-insensitive ${label} collision between "${collidingPath}" and "${normalizedPath}".`,
      "Common Windows filesystems treat those generated paths as the same file.",
      "Rename the source ids or emitted files so their normalized paths stay distinct ignoring case.",
    );
  }

  seenPaths.add(normalizedPath);
  seenCaseFoldedPaths.set(caseFoldedPath, normalizedPath);
  register(normalizedPath);
}

function isGeneratedFile(value: unknown): value is GeneratedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    "content" in value &&
    typeof value.path === "string" &&
    typeof value.content === "string"
  );
}

function generationError(code: string, message: string, detail: string, hint: string): SteleError {
  return new SteleError(code, "Generation Error", message, undefined, detail, hint);
}
