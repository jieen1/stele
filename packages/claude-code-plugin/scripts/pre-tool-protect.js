#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const PROTECTED_REASON =
  "This file is protected by Stele. Use /stele:propose-change or ask the user to approve a contract update.";
const TARGET_KEYS = ["file_path", "path", "target_path", "notebook_path"];
const PYTHON_CACHE_SUFFIXES = [".pyc", ".pyo"];

try {
  const stdin = await readStdin();
  const payload = stdin.trim().length === 0 ? {} : JSON.parse(stdin);
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
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
    const parsed = JSON.parse(raw);
    return {
      protected: Array.isArray(parsed?.protected)
        ? parsed.protected.filter((value) => typeof value === "string")
        : [],
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
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
  const normalizedInput = normalizeForComparison(normalizeInputPath(targetPath));
  const resolvedTarget = path.resolve(projectDir, targetPath);
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
      absoluteTraversalTouchesProtectedRoot(projectDir, targetPath, pattern),
  );
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

  const segments = relativePath.split("/");
  const basename = segments.at(-1) ?? "";

  return segments.includes("__pycache__") || PYTHON_CACHE_SUFFIXES.some((suffix) => basename.endsWith(suffix));
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
  return /[*?[\]]/.test(segment);
}

function isWithinProject(projectDir, candidatePath) {
  const relativePath = path.relative(projectDir, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
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
