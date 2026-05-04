import { readdir, readFile, stat } from "node:fs/promises";
import { posix, relative, resolve, win32 } from "node:path";
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

export function coordinateGeneration(contract: Contract, backend: LanguageBackend, config: GenerationConfig): GeneratedFile[] {
  const resolvedConfig = resolveGenerationConfig(config);
  const generatedFiles = backend.generate(contract, resolvedConfig);

  if (!Array.isArray(generatedFiles)) {
    throw generationError(
      "E0501",
      `Backend "${backend.name}" returned an invalid generated file list.`,
      "Expected generate() to return an array of { path, content } objects.",
      "Return a deterministic array of generated files from the backend.",
    );
  }

  return normalizeGeneratedFiles(generatedFiles, resolvedConfig.outputDir);
}

export async function verifyGenerated(
  contract: Contract,
  backend: LanguageBackend,
  config: GenerationConfig,
): Promise<GeneratedVerificationResult> {
  const resolvedConfig = resolveGenerationConfig(config);
  const expectedFiles = coordinateGeneration(contract, backend, resolvedConfig);
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file.content]));
  const actualPaths = await collectExistingGeneratedFiles(resolvedConfig.projectRoot, resolvedConfig.outputDir);
  const actualByPath = new Map<string, string>();

  await Promise.all(
    actualPaths.map(async (generatedPath) => {
      actualByPath.set(generatedPath, await readGeneratedFile(resolvedConfig.projectRoot, generatedPath));
    }),
  );

  const files: GeneratedVerificationFile[] = [];

  for (const expectedFile of expectedFiles) {
    const actualContent = actualByPath.get(expectedFile.path);

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
      status: actualContent === expectedFile.content ? "unchanged" : "changed",
      expectedContent: expectedFile.content,
      actualContent,
    });
  }

  for (const actualPath of actualPaths) {
    if (expectedByPath.has(actualPath)) {
      continue;
    }

    files.push({
      path: actualPath,
      status: "extra",
      actualContent: actualByPath.get(actualPath),
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

function normalizeGeneratedFiles(files: GeneratedFile[], outputDir: string): GeneratedFile[] {
  const normalizedFiles: GeneratedFile[] = [];
  const seenPaths = new Set<string>();

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

    if (seenPaths.has(normalizedPath)) {
      throw generationError(
        "E0503",
        `Duplicate generated file path "${normalizedPath}".`,
        "Generated file paths must be unique after normalization.",
        "Ensure the backend emits each project-relative file path exactly once.",
      );
    }

    seenPaths.add(normalizedPath);
    normalizedFiles.push({
      path: normalizedPath,
      content: file.content,
    });
  }

  normalizedFiles.sort((left, right) => left.path.localeCompare(right.path) || left.content.localeCompare(right.content));
  return normalizedFiles;
}

async function collectExistingGeneratedFiles(projectRoot: string, outputDir: string): Promise<string[]> {
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

  const files = await walkGeneratedDirectory(outputDirectoryPath, projectRoot);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function walkGeneratedDirectory(directoryPath: string, projectRoot: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const results: string[] = [];

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const fullPath = resolve(directoryPath, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await walkGeneratedDirectory(fullPath, projectRoot)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    results.push(normalizeRelativeFilePath(relative(projectRoot, fullPath), "generated disk path"));
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function generationError(code: string, message: string, detail: string, hint: string): SteleError {
  return new SteleError(code, "Generation Error", message, undefined, detail, hint);
}
