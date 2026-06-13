#!/usr/bin/env node
// Round 5 J-10: removed unused `writeFile` import — the appendFileSync
// flow is the only file-writing path here.
import { mkdir, readFile } from "node:fs/promises";
import { lstatSync, appendFileSync } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { extractPathsFromValue } from "./path-utils.js";
// Round 13 L-05/P-04: shared bash-extractor module. Replaces this
// file's earlier weaker extractor copies (which were missing
// git-checkout, interpreter `-c`, wrapper-flag peeling, `ln`,
// `rsync`, `truncate`, `chmod`, `chown` — observation audit was
// blind to those 8 vectors even though pre-tool-protect blocked them).
import { extractBashWriteTargets } from "./bash-extractors.js";
const BASH_COMMAND_KEYS = ["command"];
const MAX_PATTERN_LENGTH = 4096;
const MAX_BRACKET_DEPTH = 5;
// Round 5 J-02: keep byte-equal with packages/core/src/config/defaults.ts,
// packages/cli/src/config/defaults.ts, and packages/claude-code-plugin/
// scripts/pre-tool-protect.js. The default-protected-consistent
// self-protection checker enforces the four-way equality.
const DEFAULT_PROTECTED = [
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "contract/design/**/*",
  "contract/design/proposals/**/*",
  "contract/design/approvals/**/*",
  "contract/generated/**/*",
  "contract/provenance/**/*",
  "tests/contract/**/*",
  "packages/claude-code-plugin/scripts/pre-tool-protect.js",
  "packages/claude-code-plugin/scripts/stop-validate.js",
  "packages/claude-code-plugin/scripts/observation-hook.js",
  "packages/claude-code-plugin/scripts/lifecycle-context.js",
  // Round 13 L-05/P-04: shared bash extractor + shell helpers.
  "packages/claude-code-plugin/scripts/bash-extractors.js",
  "packages/claude-code-plugin/scripts/shell-utils.js",
  "packages/claude-code-plugin/hooks/hooks.json",
  "stele.config.json",
  ".stele/stop-state.json",
  "pnpm-lock.yaml",
  "package.json",
  "packages/*/package.json",
  "packages/*/tsup.config.ts",
  ".github/workflows/**",
  "scripts/publish-npm.mjs",
  "scripts/verify-packed-adoption.mjs",
  // Round 9 P-02: workspace topology + base TS config.
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
];

try {
  const stdin = await readStdin();
  const payload = parseHookInput(stdin);
  const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const config = await loadConfig(projectDir);

  if (config === null) {
    process.exit(0);
  }

  const targetPaths = extractTargetPaths(payload);

  if (targetPaths.length === 0) {
    process.exit(0);
  }

  const observation = {
    timestamp: new Date().toISOString(),
    session_id: getString(payload, "session_id") ?? getString(payload, "sessionId") ?? null,
    hook_event_name: getString(payload, "hook_event_name") ?? getString(payload, "hookEventName") ?? "PostToolUse",
    tool_name: getString(payload, "tool_name") ?? getString(payload, "toolName") ?? null,
    target_paths: targetPaths,
    material_change: targetPaths.some((targetPath) => isMaterialChange(projectDir, config.protected, targetPath)),
  };

  const observationPath = path.join(projectDir, ".stele", "agent", "session-observations.jsonl");

  // Round 5 J-07: check the FILE for a symlink, not just its parent dir.
  // An attacker symlinking session-observations.jsonl to /dev/null
  // would otherwise silently swallow the audit log.
  if (
    isSymlinkedPath(path.dirname(observationPath)) ||
    isSymlinkedPath(observationPath)
  ) {
    process.exit(0);
  }

  await mkdir(path.dirname(observationPath), { recursive: true });
  // Atomic append via appendFileSync: simpler and correct for ESM.
  // The 'a' flag ensures OS-level atomic seek+write, so concurrent
  // hook invocations cannot lose each other's writes.
  const content = `${JSON.stringify(observation)}\n`;
  appendFileSync(observationPath, content);
} catch {
  process.exit(0);
}

/** @stele:effects process */
async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

/** @stele:effects */
function parseHookInput(stdin) {
  if (stdin.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(stdin);
  } catch {
    return {};
  }
}

/** @stele:effects fs.read */
async function loadConfig(projectDir) {
  try {
    const raw = await readFile(path.join(projectDir, "stele.config.json"), "utf8");
    const parsed = JSON.parse(stripBom(raw));
    // Round 5 I-01: UNION user `protected` with DEFAULT_PROTECTED so the
    // observation log's "material change" detector cannot shrink its
    // tracked surface. Matches CLI loadConfig + plugin pre-tool-protect.
    const userPatterns = Array.isArray(parsed?.protected)
      ? parsed.protected.filter((p) => typeof p === "string" && p.trim().length > 0)
      : [];
    const merged = [...new Set([...DEFAULT_PROTECTED, ...userPatterns])];

    return {
      protected: merged
        .filter((pattern) => typeof pattern === "string" && pattern.trim().length > 0)
        .filter(isSafeGlobPattern),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    return {
      protected: DEFAULT_PROTECTED,
    };
  }
}

/**
 * Validate that a glob pattern is safe.
 * Rejects patterns with parent traversal, absolute paths, excessive length,
 * or bracket syntax (which can be ReDoS vectors in minimatch).
 */
function isSafeGlobPattern(pattern) {
  if (typeof pattern !== "string") {
    return false;
  }

  // Reject overly long patterns
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return false;
  }

  // Reject absolute paths
  if (isAbsoluteLikePattern(pattern)) {
    return false;
  }

  // Reject parent traversal
  if (containsParentTraversal(pattern)) {
    return false;
  }

  // Reject deeply nested bracket glob syntax (ReDoS vector in minimatch).
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

/** @stele:effects */
function isAbsoluteLikePattern(pattern) {
  return pattern.startsWith("/") || pattern.startsWith("\\") || /^[a-zA-Z]:/.test(pattern);
}

/** @stele:effects */
function containsParentTraversal(pattern) {
  const parts = pattern.split("/");
  return parts.some((part) => part === ".." || part === path.posix.sep + "..");
}

function extractTargetPaths(payload) {
  const targets = [...extractPathsFromValue(payload, new Set())];
  const bashCommand = extractBashCommand(payload);

  if (bashCommand !== null) {
    targets.push(...extractBashWriteTargets(bashCommand));
  }

  return [...new Set(targets)];
}


/** @stele:effects */
function extractBashCommand(payload) {
  if (!isObject(payload) || typeof payload.tool_name !== "string" || payload.tool_name.toLowerCase() !== "bash") {
    return null;
  }

  return extractCommandFromValue(payload, new Set());
}

/** @stele:effects */
function extractCommandFromValue(value, seen) {
  if (typeof value === "string") {
    return null;
  }

  if (!isObject(value) || seen.has(value)) {
    return null;
  }

  seen.add(value);

  for (const key of BASH_COMMAND_KEYS) {
    if (typeof value[key] === "string" && value[key].trim().length > 0) {
      return value[key];
    }
  }

  for (const nestedKey of ["tool_input", "input"]) {
    const nestedMatch = extractCommandFromValue(value[nestedKey], seen);

    if (nestedMatch !== null) {
      return nestedMatch;
    }
  }

  return null;
}

// Round 13 L-05/P-04: extractBashWriteTargets + supporting extractors
// imported from  (shared with pre-tool-protect).


/** @stele:effects */
function isMaterialChange(projectDir, protectedPatterns, targetPath) {
  const relativePath = normalizeTargetPath(projectDir, targetPath);

  if (relativePath === null || relativePath.length === 0) {
    return false;
  }

  if (relativePath.startsWith(".stele/") || relativePath.startsWith("node_modules/") || relativePath.startsWith(".git/")) {
    return false;
  }

  return !protectedPatterns.some((pattern) => matchGlob(relativePath, pattern) || matchesProtectedDirectoryRoot(relativePath, pattern));
}

function normalizeTargetPath(projectDir, targetPath) {
  const canonicalTargetPath = process.platform === "win32" ? normalizeWindowsNamespacedPath(targetPath) : targetPath;
  const resolvedTarget = path.resolve(projectDir, canonicalTargetPath);
  const relativeToProject = path.relative(projectDir, resolvedTarget);

  if (relativeToProject.startsWith("..") || path.isAbsolute(relativeToProject)) {
    return null;
  }

  return toPosixPath(relativeToProject);
}

function matchesProtectedDirectoryRoot(relativePath, pattern) {
  const protectedRootPattern = getProtectedDirectoryRootPattern(pattern);

  if (protectedRootPattern === null) {
    return false;
  }

  return matchGlob(relativePath, protectedRootPattern);
}

/** @stele:effects */
function getProtectedDirectoryRootPattern(pattern) {
  const normalizedPattern = toPosixPath(pattern).replace(/\/+$/u, "");

  if (!normalizedPattern.endsWith("/**/*")) {
    return null;
  }

  const rootPattern = normalizedPattern.slice(0, -"/**/*".length);
  return rootPattern.length > 0 ? rootPattern : null;
}

function matchGlob(relativePath, pattern) {
  if (relativePath.length === 0 || !isSafeGlobPattern(pattern)) {
    return false;
  }

  return minimatch(relativePath, pattern, {
    dot: true,
    nocase: process.platform === "win32",
  });
}

/** @stele:effects */
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

function getString(value, key) {
  return isObject(value) && typeof value[key] === "string" ? value[key] : null;
}

/** @stele:effects */
function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @stele:effects */
function stripBom(value) {
  return value.replace(/^\uFEFF/u, "");
}

function isSymlinkedPath(checkPath) {
  try {
    const stats = lstatSync(checkPath);
    if (stats.isSymbolicLink()) {
      return true;
    }
  } catch {
    // Path doesn't exist \u2014 will be created by mkdir
  }
  return false;
}
