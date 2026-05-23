#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchProtectedPath } from "@stele/agent-hooks";
import { TARGET_KEYS } from "./path-utils.js";
import {
  joinContinuationLines,
  parseLiteralShellPath,
  stripShellComment,
  tokenizeShellLine,
} from "./shell-utils.js";

const BLOCK_EXIT_CODE = 2;
const PROTECTED_REASON = [
  "This file is protected by Stele.",
  "Prefer fixing ordinary source code, fixtures, or scenario setup before changing protected contract material.",
  "Before changing protected files, answer:",
  "1. Is the existing contract still correct and my source change wrong?",
  "2. Can I satisfy the contract without editing contract/, tests/contract/, manifest, or baseline files?",
  "3. Has the user explicitly approved a contract change after reviewing the affected protected files?",
  "For new invariant knowledge, use the CLI command `stele propose invariant --id <id> --severity <error|warning|info> --description <text> --assert <cdl> --apply`.",
  "For modifying or deleting existing protected rules, stop and ask the user to review the contract change.",
  "Do not use a skill invocation for this; this plugin exposes CLI commands and slash-command docs, not a callable add skill.",
].join("\n");
const PROTECTED_REPEAT_REASON =
  "Protected Stele edit is still blocked; detailed guidance was already shown earlier in this session. Ask the user to review the contract change, or add new invariant knowledge with `stele propose invariant --id <id> --severity <error|warning|info> --description <text> --assert <cdl> --apply`. Do not use a skill invocation for this.";
const BASH_COMMAND_KEYS = ["command"];
const COMMAND_SEPARATOR_TOKENS = new Set(["|", "||", "&&", "&", ";"]);
const DEFAULT_PROTECTED = [
  "contract/**/*.stele",
  "contract/checker_impls/**/*",
  "contract/design/**/*",
  "contract/design/proposals/**/*",
  "contract/generated/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "tests/contract/**/*",
  // Hook scripts - security-critical, must not be editable by agents
  "packages/claude-code-plugin/scripts/pre-tool-protect.js",
  "packages/claude-code-plugin/scripts/stop-validate.js",
  "packages/claude-code-plugin/scripts/observation-hook.js",
  "packages/claude-code-plugin/scripts/lifecycle-context.js",
  "packages/claude-code-plugin/hooks/hooks.json",
  // Config files - protect against tampering
  "stele.config.json",
  // Stele runtime state — Stop hook loop-guard fingerprint store.
  // (Round 3 Reviewer G P0-1: without this, an agent can pre-fill
  // .stele/stop-state.json to bypass the two-attempt human floor.)
  // Note: `.stele/events/**` is intentionally NOT protected — those are
  // append-only observation logs the Stop hook writes on every run.
  ".stele/stop-state.json",
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

  const deniedTargets = targetPaths.filter((targetPath) => shouldDenyTarget(projectDir, config.protected, targetPath));

  if (deniedTargets.length > 0) {
    const reason = await getProtectedEditReason(projectDir, payload, deniedTargets);
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
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
    // Round 3 Reviewer G P0-3: UNION default + user patterns, never replace.
    // Replacing on `protected` let adopters silently drop hook scripts, the
    // stele.config.json itself, and other security-critical paths from the
    // glob — a complete kill switch. User config can only ADD patterns now,
    // never narrow the default set.
    const userPatterns = Object.prototype.hasOwnProperty.call(parsed ?? {}, "protected")
      ? readProtectedConfig(parsed?.protected)
      : [];

    const merged = new Set([...DEFAULT_PROTECTED, ...userPatterns]);

    return {
      protected: [...merged],
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

    if (pattern.split("[").length > 3) {
      throw new Error(`unsupported glob pattern in protected config: deeply nested bracket syntax is not supported: ${pattern}`);
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
  return isObject(payload) && typeof payload.tool_name === "string" && payload.tool_name.toLowerCase() === "bash";
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
  const commands = new Set(["cp", "mv", "install"]);
  let segmentStart = 0;

  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index];

    if (index === tokens.length || (token.type === "operator" && COMMAND_SEPARATOR_TOKENS.has(token.value))) {
      targets.push(...extractFileOperationTargetsFromSegment(tokens.slice(segmentStart, index), commands));
      segmentStart = index + 1;
    }
  }

  return targets;
}

function extractFileOperationTargetsFromSegment(tokens, commands) {
  const commandToken = tokens.find((token) => token.type === "word");

  if (!commandToken || !commands.has(path.posix.basename(commandToken.value))) {
    return [];
  }

  const targets = [];
  const wordTokens = [];
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

    wordTokens.push(token);
  }

  if (wordTokens.length > 0) {
    const lastToken = wordTokens[wordTokens.length - 1];
    const literalPath = parseLiteralShellPath(lastToken.value);

    if (literalPath !== null) {
      targets.push(literalPath);
    }
  }

  return targets;
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

/**
 * Decide whether `targetPath` should be denied. Delegates to the SDK so the
 * matching logic stays in @stele/agent-hooks; this script focuses on
 * Claude-Code-specific stdin parsing and tool-payload extraction.
 */
function shouldDenyTarget(projectDir, patterns, targetPath) {
  return matchProtectedPath(targetPath, patterns, projectDir);
}

async function getProtectedEditReason(projectDir, payload, deniedTargets) {
  const sessionId = resolveSessionId(payload);

  if (sessionId === null) {
    return PROTECTED_REASON;
  }

  const markerPath = path.join(projectDir, ".stele", "agent", `${safeFileName(sessionId)}.protected-edit-guidance.json`);

  if (await fileExists(markerPath)) {
    return PROTECTED_REPEAT_REASON;
  }

  try {
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify({
        session_id: sessionId,
        first_seen_at: new Date().toISOString(),
        target_paths: deniedTargets,
      })}\n`,
      "utf8",
    );
  } catch {
    // Guidance state is best-effort. If it cannot be written, keep blocking
    // with the full reason instead of failing the hook for an auxiliary file.
  }

  return PROTECTED_REASON;
}

function resolveSessionId(payload) {
  if (isObject(payload) && typeof payload.session_id === "string" && payload.session_id.trim().length > 0) {
    return payload.session_id;
  }

  if (isObject(payload) && typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0) {
    return payload.sessionId;
  }

  return null;
}

async function fileExists(filePath) {
  return await access(filePath, constants.F_OK).then(
    () => true,
    () => false,
  );
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
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

function failClosed(message) {
  process.stderr.write(`${message}\n`);
  process.exit(BLOCK_EXIT_CODE);
}
