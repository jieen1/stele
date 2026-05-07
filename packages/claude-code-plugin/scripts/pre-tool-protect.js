#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { TARGET_KEYS } from "./path-utils.js";

const BLOCK_EXIT_CODE = 2;
const PROTECTED_REASON =
  "This file is protected by Stele. Use /stele:add or ask the user to approve a contract update.";
const BASH_COMMAND_KEYS = ["command"];
const COMMAND_SEPARATOR_TOKENS = new Set(["|", "||", "&&", ";"]);
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
  const targetPaths = extractTargetPaths(payload);

  if (targetPaths.length === 0) {
    process.exit(0);
  }

  const config = await loadConfig(projectDir);

  if (config === null) {
    process.exit(0);
  }

  const decision = targetPaths.some((targetPath) => shouldDenyTarget(projectDir, config.protected, targetPath));

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
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
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

function extractTargetPaths(payload) {
  const targets = [];
  const structuredTarget = extractStructuredTargetPath(payload);

  if (structuredTarget !== null) {
    targets.push(structuredTarget);
  }

  const bashCommand = extractBashCommand(payload);

  if (bashCommand !== null) {
    targets.push(...extractBashWriteTargets(bashCommand));
  }

  return [...new Set(targets)];
}

function extractStructuredTargetPath(payload) {
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

function extractBashCommand(payload) {
  if (!isBashPayload(payload)) {
    return null;
  }

  return extractCommandFromValue(payload, new Set());
}

function isBashPayload(payload) {
  return isObject(payload) && typeof payload.tool_name === "string" && payload.tool_name === "Bash";
}

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
    const nestedValue = value[nestedKey];
    const nestedMatch = extractCommandFromValue(nestedValue, seen);

    if (nestedMatch !== null) {
      return nestedMatch;
    }
  }

  return null;
}

function extractBashWriteTargets(command) {
  const targets = [];
  const pendingHeredocs = [];
  const lines = command.split(/\r?\n/u);

  for (const line of lines) {
    const activeLine = stripShellComment(line);

    if (pendingHeredocs.length > 0) {
      if (line.trim() === pendingHeredocs[0]) {
        pendingHeredocs.shift();
      }

      continue;
    }

    targets.push(...extractWriteTargetsFromLine(activeLine));
    pendingHeredocs.push(...extractHeredocDelimiters(activeLine));
  }

  return [...new Set(targets)];
}

function extractWriteTargetsFromLine(line) {
  if (line.trim().length === 0) {
    return [];
  }

  const tokens = tokenizeShellLine(line);
  return [...extractRedirectTargets(tokens), ...extractTeeTargets(tokens)];
}

function extractRedirectTargets(tokens) {
  const targets = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.type !== "operator" || (token.value !== ">" && token.value !== ">>")) {
      continue;
    }

    const nextToken = tokens[index + 1];
    const literalPath = nextToken?.type === "word" ? parseLiteralShellPath(nextToken.value) : null;

    if (literalPath !== null) {
      targets.push(literalPath);
    }
  }

  return targets;
}

function extractTeeTargets(tokens) {
  const targets = [];
  let segmentStart = 0;

  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];

    if (index === tokens.length || (token.type === "operator" && COMMAND_SEPARATOR_TOKENS.has(token.value))) {
      targets.push(...extractTeeTargetsFromSegment(tokens.slice(segmentStart, index)));
      segmentStart = index + 1;
    }
  }

  return targets;
}

function extractTeeTargetsFromSegment(tokens) {
  const commandToken = tokens.find((token) => token.type === "word");

  if (!commandToken || path.posix.basename(commandToken.value) !== "tee") {
    return [];
  }

  const targets = [];
  let sawDoubleDash = false;

  for (const token of tokens.slice(tokens.indexOf(commandToken) + 1)) {
    if (token.type !== "word") {
      continue;
    }

    if (!sawDoubleDash && token.value === "--") {
      sawDoubleDash = true;
      continue;
    }

    if (!sawDoubleDash && token.value.startsWith("-")) {
      continue;
    }

    const literalPath = parseLiteralShellPath(token.value);

    if (literalPath !== null) {
      targets.push(literalPath);
    }
  }

  return targets;
}

function extractHeredocDelimiters(line) {
  const delimiters = [];
  const regex = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([^\s"'`<>|&;()]+))/gu;

  for (const match of line.matchAll(regex)) {
    const delimiter = match[1] ?? match[2] ?? match[3] ?? "";

    if (delimiter.length > 0) {
      delimiters.push(delimiter);
    }
  }

  return delimiters;
}

function stripShellComment(line) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote === null && char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "'" || char === '"') {
      if (quote === char) {
        quote = null;
      } else if (quote === null) {
        quote = char;
      }

      continue;
    }

    if (quote !== null) {
      continue;
    }

    if (char === "#" && startsShellComment(line, index)) {
      return line.slice(0, index);
    }
  }

  return line;
}

function startsShellComment(line, index) {
  if (index === 0) {
    return true;
  }

  return /[\s;|&()]/u.test(line[index - 1] ?? "");
}

function tokenizeShellLine(line) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quote !== null) {
      current += char;

      if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      pushWordToken(tokens, current);
      current = "";
      continue;
    }

    const twoChar = line.slice(index, index + 2);

    if (twoChar === ">>" || twoChar === "||" || twoChar === "&&" || twoChar === "<<" || twoChar === "<<") {
      pushWordToken(tokens, current);
      current = "";
      tokens.push({ type: "operator", value: twoChar });
      index += 1;
      continue;
    }

    if (char === ">" || char === "|" || char === ";" || char === "<") {
      pushWordToken(tokens, current);
      current = "";
      tokens.push({ type: "operator", value: char });
      continue;
    }

    current += char;
  }

  pushWordToken(tokens, current);
  return tokens;
}

function pushWordToken(tokens, value) {
  if (value.length > 0) {
    tokens.push({ type: "word", value });
  }
}

function parseLiteralShellPath(token) {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  let candidate = token;

  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1);
  }

  if (
    candidate.length === 0 ||
    /[$`*?[\]{}()|&;]/u.test(candidate) ||
    candidate.includes("\n") ||
    candidate.includes("\r")
  ) {
    return null;
  }

  return candidate;
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
    return patterns.some((pattern) => matchGlob(relativeToProject, pattern) || matchesProtectedDirectoryRoot(relativeToProject, pattern));
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

function matchesProtectedDirectoryRoot(relativePath, pattern) {
  const protectedRootPattern = getProtectedDirectoryRootPattern(pattern);

  if (protectedRootPattern === null) {
    return false;
  }

  return matchGlob(relativePath, protectedRootPattern);
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

function getProtectedDirectoryRootPattern(pattern) {
  const normalizedPattern = toPosixPath(pattern).replace(/\/+$/u, "");

  if (!normalizedPattern.endsWith("/**/*")) {
    return null;
  }

  const rootPattern = normalizedPattern.slice(0, -"/**/*".length);
  return rootPattern.length > 0 ? rootPattern : null;
}

function matchGlob(relativePath, pattern) {
  if (relativePath.length === 0) {
    return false;
  }

  return minimatch(relativePath, pattern, {
    dot: true,
    windowsPathsNoEscape: true,
    nocase: process.platform === "win32",
  });
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
