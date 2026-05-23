import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";

/**
 * Pure-JS port of the protected-path matching used by the Claude Code plugin
 * (`packages/claude-code-plugin/scripts/pre-tool-protect.js`). Behaviour MUST
 * stay byte-equivalent because the plugin tests treat the script behaviour as
 * source of truth.
 */

const PYTHON_CACHE_SUFFIXES = [".pyc", ".pyo"];

/**
 * Return true when `targetPath` should be denied based on the given
 * project-relative glob `patterns`.
 *
 * @param targetPath Tool-supplied path (raw; may be absolute or relative,
 *                   may contain Windows separators / namespaces).
 * @param patterns   Project-relative glob patterns from
 *                   {@link "@stele/cli".SteleConfig.protected}.
 * @param projectRoot Absolute project root; used to resolve relative paths
 *                    and to detect whether absolute targets traverse into
 *                    protected directories.
 */
export function matchProtectedPath(
  targetPath: string,
  patterns: readonly string[],
  projectRoot: string,
): boolean {
  if (targetPath.length === 0) {
    return false;
  }

  const canonicalTargetPath = canonicalizeTargetPath(targetPath);
  const normalizedInput = normalizeForComparison(normalizeInputPath(canonicalTargetPath));
  const resolvedTarget = path.resolve(projectRoot, canonicalTargetPath);
  // Round 4 D-06: realpath the resolved target before matching. Without
  // this an agent can create a symlink at /tmp/decoy that points to a
  // protected file inside the project, then "write to /tmp/decoy" — the
  // pre-realpath path comparison sees `/tmp/decoy` (outside project,
  // permitted) but the OS write lands on `<project>/contract/main.stele`.
  // Errors during realpath (file doesn't exist yet, EACCES) fall back to
  // the raw resolved path — we never UPGRADE permissions on failure.
  const realpathedTarget = (() => {
    try {
      return fs.realpathSync(resolvedTarget);
    } catch {
      return resolvedTarget;
    }
  })();
  const relativeToProject = normalizeForComparison(toPosixPath(path.relative(projectRoot, realpathedTarget)));
  const withinProject = isWithinProject(projectRoot, realpathedTarget);

  if (withinProject && shouldIgnorePythonCache(relativeToProject)) {
    return false;
  }

  if (withinProject) {
    return patterns.some(
      (pattern) =>
        matchGlob(relativeToProject, pattern) || matchesProtectedDirectoryRoot(relativeToProject, pattern),
    );
  }

  if (shouldIgnorePythonCache(normalizedInput)) {
    return false;
  }

  return patterns.some(
    (pattern) =>
      startsWithinProtectedPrefix(normalizedInput, pattern) ||
      absoluteTraversalTouchesProtectedRoot(projectRoot, canonicalTargetPath, pattern),
  );
}

function canonicalizeTargetPath(targetPath: string): string {
  if (process.platform !== "win32") {
    return targetPath;
  }

  return normalizeWindowsNamespacedPath(targetPath);
}

function normalizeInputPath(targetPath: string): string {
  return toPosixPath(targetPath)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

function shouldIgnorePythonCache(relativePath: string): boolean {
  if (relativePath.length === 0) {
    return false;
  }

  const basename = relativePath.split("/").at(-1) ?? "";
  return PYTHON_CACHE_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

function startsWithinProtectedPrefix(relativePath: string, pattern: string): boolean {
  const segments = relativePath.split("/").map((seg) => normalizeForComparison(seg));
  const prefixSegments = getProtectedPrefix(pattern).map((seg) => normalizeForComparison(seg));

  if (prefixSegments.length === 0 || segments.length < prefixSegments.length) {
    return false;
  }

  return prefixSegments.every((segment, index) => segments[index] === segment);
}

function matchesProtectedDirectoryRoot(relativePath: string, pattern: string): boolean {
  const protectedRootPattern = getProtectedDirectoryRootPattern(pattern);

  if (protectedRootPattern === null) {
    return false;
  }

  return matchGlob(relativePath, protectedRootPattern);
}

function absoluteTraversalTouchesProtectedRoot(projectDir: string, targetPath: string, pattern: string): boolean {
  if (!path.isAbsolute(targetPath)) {
    return false;
  }

  const projectPrefix = normalizeForComparison(normalizeAbsolutePrefix(projectDir));
  const rawAbsolute = normalizeForComparison(normalizeAbsolutePrefix(targetPath));
  const prefixSegments = getProtectedPrefix(pattern);

  if (prefixSegments.length === 0 || !rawAbsolute.startsWith(`${projectPrefix}/`)) {
    return false;
  }

  const rawRelative = rawAbsolute.slice(projectPrefix.length + 1);
  return startsWithinProtectedPrefix(rawRelative, pattern);
}

function getProtectedPrefix(pattern: string): string[] {
  const segments = normalizeForComparison(toPosixPath(pattern))
    .split("/")
    .filter((segment) => segment.length > 0);
  const prefix: string[] = [];

  for (const segment of segments) {
    if (hasGlobMeta(segment)) {
      break;
    }

    prefix.push(segment);
  }

  return prefix;
}

function getProtectedDirectoryRootPattern(pattern: string): string | null {
  const normalizedPattern = toPosixPath(pattern).replace(/\/+$/u, "");

  if (!normalizedPattern.endsWith("/**/*")) {
    return null;
  }

  const rootPattern = normalizedPattern.slice(0, -"/**/*".length);
  return rootPattern.length > 0 ? rootPattern : null;
}

/**
 * Maximum pattern length for minimatch. Prevents ReDoS where an adversarial
 * pattern forces the regex engine into exponential backtracking.
 */
const MAX_PATTERN_LENGTH = 4096;

/**
 * Maximum bracket nesting depth. Deeply nested bracket expressions
 * (`[a-[b-[c-...]`) are a classic ReDoS vector for glob engines.
 */
const MAX_BRACKET_DEPTH = 5;

/**
 * Check if a glob pattern is safe to pass to minimatch.
 * Returns false for patterns that could cause ReDoS.
 */
export function isSafeGlobPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return false;
  }

  let depth = 0;
  for (const char of pattern) {
    if (char === "[") {
      depth++;
      if (depth > MAX_BRACKET_DEPTH) {
        return false;
      }
    } else if (char === "]") {
      depth--;
    }
  }

  return true;
}

function matchGlob(relativePath: string, pattern: string): boolean {
  if (relativePath.length === 0 || !isSafeGlobPattern(pattern)) {
    return false;
  }

  return minimatch(relativePath, pattern, {
    dot: true,
    nocase: process.platform === "win32",
  });
}

function hasGlobMeta(segment: string): boolean {
  return /[*?]/u.test(segment);
}

function isWithinProject(projectDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(projectDir, candidatePath);
  if (relativePath.length === 0) return true;
  // On Windows, path.relative("C:\\project", "D:\\other") returns "D:\\other"
  // (full path, not starting with ".."). Catch this via isAbsolute.
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeWindowsNamespacedPath(value: string): string {
  const uncMatch = value.match(/^[\\/]{2}[?.][\\/]+UNC[\\/]+(.+)$/iu);

  if (uncMatch) {
    return `\\\\${uncMatch[1]!.replaceAll("/", "\\")}`;
  }

  const namespacedMatch = value.match(/^[\\/]{2}[?.][\\/]+(.+)$/u);

  if (namespacedMatch) {
    return namespacedMatch[1]!;
  }

  return value;
}

function normalizeAbsolutePrefix(value: string): string {
  return toPosixPath(value).replace(/\/+$/u, "");
}

function normalizeForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
