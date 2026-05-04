#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const BLOCK_EXIT_CODE = 2;
const PROTECTED_REASON =
  "This file is protected by Stele. Use /stele:add or ask the user to approve a contract update.";
const TARGET_KEYS = ["file_path", "path", "target_path", "notebook_path"];
const PYTHON_CACHE_SUFFIXES = [".pyc", ".pyo"];
const DEFAULT_PROTECTED = [
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/.manifest.json",
  "tests/contract/**/*",
];

try {
  const stdin = await readStdin();
  const payload = parseHookInput(stdin);
  const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const targetPath = extractTargetPath(payload);

  if (targetPath === null) {
    process.exit(0);
  }

  const config = await loadConfig(projectDir);

  if (config === null) {
    process.exit(0);
  }

  const decision = shouldDenyTarget(projectDir, config.protected, targetPath);

  if (decision) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: PROTECTED_REASON,
        },
      })}\n`,
    );
  }
} catch (error) {
  failClosed(error instanceof Error ? error.message : String(error));
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

async function loadConfig(projectDir) {
  try {
    const raw = await readFile(path.join(projectDir, "stele.config.json"), "utf8");
    const parsed = JSON.parse(stripBom(raw));
    const protectedPatterns = Object.prototype.hasOwnProperty.call(parsed ?? {}, "protected")
      ? readProtectedConfig(parsed?.protected)
      : [...DEFAULT_PROTECTED];

    return {
      protected: protectedPatterns,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw new Error(`Unable to parse Stele config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readProtectedConfig(value) {
  if (!Array.isArray(value)) {
    throw new Error("invalid protected config: protected must be an array of strings.");
  }

  for (const pattern of value) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("invalid protected config: protected must be an array of strings.");
    }

    if (isAbsoluteLikePattern(pattern) || containsParentTraversal(pattern)) {
      throw new Error(`invalid protected config: protected patterns must be project-relative and must not contain '..': ${pattern}`);
    }

    if (pattern.includes("[") || pattern.includes("]")) {
      throw new Error(`unsupported glob pattern in protected config: bracket syntax is not supported: ${pattern}`);
    }
  }

  return [...value];
}

function isAbsoluteLikePattern(pattern) {
  return /^(?:[A-Za-z]:|[\\/]{1,2})/.test(pattern);
}

function containsParentTraversal(pattern) {
  return toPosixPath(pattern)
    .split("/")
    .some((segment) => segment === "..");
}

function parseHookInput(stdin) {
  if (stdin.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(stdin);
  } catch (error) {
    throw new Error(`Unable to parse Claude hook input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractTargetPath(payload) {
  return extractFromValue(payload, new Set());
}

function extractFromValue(value, seen) {
  if (typeof value === "string") {
    return null;
  }

  if (!isObject(value) || seen.has(value)) {
    return null;
  }

  seen.add(value);

  for (const key of TARGET_KEYS) {
    if (typeof value[key] === "string" && value[key].trim().length > 0) {
      return value[key];
    }
  }

  for (const nestedKey of ["tool_input", "input"]) {
    const nestedValue = value[nestedKey];
    const nestedMatch = extractFromValue(nestedValue, seen);

    if (nestedMatch !== null) {
      return nestedMatch;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const nestedMatch = extractFromValue(nestedValue, seen);

    if (nestedMatch !== null) {
      return nestedMatch;
    }
  }

  return null;
}

function shouldDenyTarget(projectDir, patterns, targetPath) {
  const canonicalTargetPath = canonicalizeTargetPath(targetPath);
  const normalizedInput = normalizeForComparison(normalizeInputPath(canonicalTargetPath));
  const resolvedTarget = path.resolve(projectDir, canonicalTargetPath);
  const relativeToProject = normalizeForComparison(toPosixPath(path.relative(projectDir, resolvedTarget)));
  const withinProject = isWithinProject(projectDir, resolvedTarget);

  if (withinProject && shouldIgnorePythonCache(relativeToProject)) {
    return false;
  }

  if (withinProject) {
    return patterns.some((pattern) => matchGlob(relativeToProject, pattern));
  }

  if (shouldIgnorePythonCache(normalizedInput)) {
    return false;
  }

  return patterns.some(
    (pattern) =>
      startsWithinProtectedPrefix(normalizedInput, pattern) ||
      absoluteTraversalTouchesProtectedRoot(projectDir, canonicalTargetPath, pattern),
  );
}

function canonicalizeTargetPath(targetPath) {
  if (process.platform !== "win32") {
    return targetPath;
  }

  return normalizeWindowsNamespacedPath(targetPath);
}

function normalizeInputPath(targetPath) {
  const normalized = toPosixPath(targetPath)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");

  return normalized.join("/");
}

function shouldIgnorePythonCache(relativePath) {
  if (relativePath.length === 0) {
    return false;
  }

  const basename = relativePath.split("/").at(-1) ?? "";

  return PYTHON_CACHE_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

function startsWithinProtectedPrefix(relativePath, pattern) {
  const segments = relativePath.split("/");
  const prefixSegments = getProtectedPrefix(pattern);

  if (prefixSegments.length === 0 || segments.length < prefixSegments.length) {
    return false;
  }

  return prefixSegments.every((segment, index) => segments[index] === segment);
}

function absoluteTraversalTouchesProtectedRoot(projectDir, targetPath, pattern) {
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

function getProtectedPrefix(pattern) {
  const segments = normalizeForComparison(toPosixPath(pattern))
    .split("/")
    .filter((segment) => segment.length > 0);
  const prefix = [];

  for (const segment of segments) {
    if (hasGlobMeta(segment)) {
      break;
    }

    prefix.push(segment);
  }

  return prefix;
}

function matchGlob(relativePath, pattern) {
  if (relativePath.length === 0) {
    return false;
  }

  const regex = compileGlob(pattern);
  return regex.test(relativePath);
}

function compileGlob(pattern) {
  const segments = normalizeForComparison(toPosixPath(pattern))
    .split("/")
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return /^$/;
  }

  let source = "^";

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];

    if (segment === "**") {
      if (index === 0) {
        source += "(?:[^/]+/)*";
      } else {
        source += "(?:/[^/]+)*";
      }

      continue;
    }

    if (index > 0 && segments[index - 1] !== "**") {
      source += "/";
    } else if (index > 0 && segments[index - 1] === "**") {
      source += "/";
    }

    source += escapeSegment(segment)
      .replace(/\\\*/g, "[^/]*")
      .replace(/\\\?/g, "[^/]");
  }

  source += "$";
  return new RegExp(source);
}

function escapeSegment(segment) {
  return segment.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function hasGlobMeta(segment) {
  return /[*?]/.test(segment);
}

function isWithinProject(projectDir, candidatePath) {
  const relativePath = path.relative(projectDir, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

function normalizeWindowsNamespacedPath(value) {
  const uncMatch = value.match(/^[\\/]{2}[?.][\\/]+UNC[\\/]+(.+)$/iu);

  if (uncMatch) {
    return `\\\\${uncMatch[1].replaceAll("/", "\\")}`;
  }

  const namespacedMatch = value.match(/^[\\/]{2}[?.][\\/]+(.+)$/u);

  if (namespacedMatch) {
    return namespacedMatch[1];
  }

  return value;
}

function normalizeAbsolutePrefix(value) {
  return toPosixPath(value).replace(/\/+$/u, "");
}

function normalizeForComparison(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stripBom(value) {
  return value.replace(/^\uFEFF/u, "");
}

function failClosed(message) {
  process.stderr.write(`${message}\n`);
  process.exit(BLOCK_EXIT_CODE);
}
