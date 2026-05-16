import { posix, win32 } from "node:path";
import { DEFAULT_GENERATED_OUTPUT_DIR } from "./types.js";
import { generationError } from "./errors.js";

export function normalizeRelativePath(pathValue: string, label: string): string {
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

export function normalizeRelativeDirectoryPath(pathValue: string, label: string): string {
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

export function normalizeRelativeFilePath(pathValue: string, label: string): string {
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

export function assertPathWithinOutputDirectory(filePath: string, outputDir: string): void {
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

export function normalizeFileExtension(fileExtension: string): string {
  if (typeof fileExtension !== "string" || !/^[\._][A-Za-z0-9_.]+$/.test(fileExtension)) {
    throw generationError(
      "E0502",
      `Invalid backend file extension "${fileExtension}".`,
      "Expected a simple extension such as .py or .ts for canonical generated output.",
      "Set backend.fileExtension to a dot-prefixed extension without path separators.",
    );
  }

  return fileExtension;
}

export function sanitizeGeneratedPathSegment(value: string, fallbackPrefix: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withFallback = sanitized.length === 0 ? fallbackPrefix : sanitized;
  return /^[0-9]/.test(withFallback) ? `${fallbackPrefix}_${withFallback}` : withFallback;
}
