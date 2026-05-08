#!/usr/bin/env node
import { readFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { extractPathsFromValue } from "./path-utils.js";
import {
  joinContinuationLines,
  parseLiteralShellPath,
  stripShellComment,
  tokenizeShellLine,
} from "./shell-utils.js";
const BASH_COMMAND_KEYS = ["command"];
const COMMAND_SEPARATOR_TOKENS = new Set(["|", "||", "&&", "&", ";"]);
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
  await mkdir(path.dirname(observationPath), { recursive: true });
  await appendFile(observationPath, `${JSON.stringify(observation)}\n`, "utf8");
} catch {
  process.exit(0);
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

function parseHookInput(stdin) {
  if (stdin.trim().length === 0) {
    return {};
  }

  return JSON.parse(stdin);
}

async function loadConfig(projectDir) {
  try {
    const raw = await readFile(path.join(projectDir, "stele.config.json"), "utf8");
    const parsed = JSON.parse(stripBom(raw));
    const protectedPatterns = Array.isArray(parsed?.protected) ? parsed.protected : DEFAULT_PROTECTED;

    return {
      protected: protectedPatterns.filter((pattern) => typeof pattern === "string" && pattern.trim().length > 0),
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

function extractTargetPaths(payload) {
  const targets = [...extractPathsFromValue(payload, new Set())];
  const bashCommand = extractBashCommand(payload);

  if (bashCommand !== null) {
    targets.push(...extractBashWriteTargets(bashCommand));
  }

  return [...new Set(targets)];
}


function extractBashCommand(payload) {
  if (!isObject(payload) || payload.tool_name !== "Bash") {
    return null;
  }

  return extractCommandFromValue(payload, new Set());
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
    const nestedMatch = extractCommandFromValue(value[nestedKey], seen);

    if (nestedMatch !== null) {
      return nestedMatch;
    }
  }

  return null;
}

function extractBashWriteTargets(command) {
  const targets = [];
  const pendingHeredocs = [];
  const lines = joinContinuationLines(command.split(/\r?\n/u));

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
  return [
    ...extractRedirectTargets(tokens),
    ...extractTeeTargets(tokens),
    ...extractFileOperationTargets(tokens),
    ...extractDdTargets(tokens),
  ];
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

function extractFileOperationTargets(tokens) {
  const targets = [];
  let segmentStart = 0;

  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];

    if (index === tokens.length || (token.type === "operator" && COMMAND_SEPARATOR_TOKENS.has(token.value))) {
      targets.push(...extractFileOperationTargetsFromSegment(tokens.slice(segmentStart, index)));
      segmentStart = index + 1;
    }
  }

  return targets;
}

function extractFileOperationTargetsFromSegment(tokens) {
  const wordTokens = [];

  for (const token of tokens) {
    if (token.type === "word") {
      wordTokens.push(token);
    }
  }

  if (wordTokens.length === 0) {
    return [];
  }

  const commandToken = wordTokens[0];
  const basename = path.posix.basename(commandToken.value);

  if (basename !== "cp" && basename !== "mv" && basename !== "install") {
    return [];
  }

  // Find the last non-flag word token (destination)
  let lastWord = null;
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

    lastWord = token;
  }

  if (lastWord !== null) {
    const literalPath = parseLiteralShellPath(lastWord.value);

    if (literalPath !== null) {
      return [literalPath];
    }
  }

  return [];
}

function extractDdTargets(tokens) {
  const targets = [];
  let segmentStart = 0;

  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];

    if (index === tokens.length || (token.type === "operator" && COMMAND_SEPARATOR_TOKENS.has(token.value))) {
      targets.push(...extractDdTargetsFromSegment(tokens.slice(segmentStart, index)));
      segmentStart = index + 1;
    }
  }

  return targets;
}

function extractDdTargetsFromSegment(tokens) {
  const wordTokens = [];

  for (const token of tokens) {
    if (token.type === "word") {
      wordTokens.push(token);
    }
  }

  if (wordTokens.length === 0) {
    return [];
  }

  const commandToken = wordTokens[0];

  if (path.posix.basename(commandToken.value) !== "dd") {
    return [];
  }

  const targets = [];

  for (const token of tokens.slice(tokens.indexOf(commandToken) + 1)) {
    if (token.type !== "word") {
      continue;
    }

    const ofMatch = token.value.match(/^of=(.+)$/u);

    if (ofMatch) {
      const literalPath = parseLiteralShellPath(ofMatch[1]);

      if (literalPath !== null) {
        targets.push(literalPath);
      }
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

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
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
