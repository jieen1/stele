#!/usr/bin/env node
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { matchProtectedPath } from "@stele/agent-hooks";
import { TARGET_KEYS } from "./path-utils.js";
// Round 13 L-05/P-04: shared bash-write-target extractors. The
// observation hook imports the same module so the two stay in lockstep.
// The low-level shell-utils helpers (tokenize / parseLiteral / strip
// comment) are now used only by bash-extractors.js, not this file.
import { extractBashWriteTargets } from "./bash-extractors.js";

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
  "contract/design/approvals/**/*",
  "contract/generated/**/*",
  "contract/provenance/**/*",
  "contract/.baseline.json",
  "contract/.manifest.json",
  "tests/contract/**/*",
  // Hook scripts - security-critical, must not be editable by agents
  "packages/claude-code-plugin/scripts/pre-tool-protect.js",
  "packages/claude-code-plugin/scripts/stop-validate.js",
  "packages/claude-code-plugin/scripts/observation-hook.js",
  "packages/claude-code-plugin/scripts/lifecycle-context.js",
  // Round 13 L-05/P-04: shared bash extractor + shell helpers.
  "packages/claude-code-plugin/scripts/bash-extractors.js",
  "packages/claude-code-plugin/scripts/shell-utils.js",
  "packages/claude-code-plugin/hooks/hooks.json",
  // Config files - protect against tampering
  "stele.config.json",
  // Stele runtime state — Stop hook loop-guard fingerprint store.
  // (Round 3 Reviewer G P0-1: without this, an agent can pre-fill
  // .stele/stop-state.json to bypass the two-attempt human floor.)
  // Note: `.stele/events/**` is intentionally NOT protected — those are
  // append-only observation logs the Stop hook writes on every run.
  ".stele/stop-state.json",
  // Round 4 E-09: supply-chain shape (kept byte-equal with cli/core).
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

// Round 13 L-05/P-04: interpreter names + wrapper names + interpreter
// write-hints moved into `bash-extractors.js`. Both extractor consumers
// (this file and observation-hook.js) now share the same definitions.

await main();

async function main() {
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
}

/** @stele:effects process */
async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

/** @stele:effects fs.read */
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

/** @stele:effects */
function containsParentTraversal(pattern) {
  return toPosixPath(pattern)
    .split("/")
    .some((segment) => segment === "..");
}

/** @stele:effects */
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

/** @stele:effects */
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

/** @stele:effects */
function isBashPayload(payload) {
  return isObject(payload) && typeof payload.tool_name === "string" && payload.tool_name.toLowerCase() === "bash";
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
    const nestedValue = value[nestedKey];
    const nestedMatch = extractCommandFromValue(nestedValue, seen);

    if (nestedMatch !== null) {
      return nestedMatch;
    }
  }

  return null;
}

// Round 13 L-05/P-04: extractBashWriteTargets + the full extractor
// suite (redirect / tee / file-op / dd / git-checkout / interpreter /
// heredoc / _firstRealCommandIndex) live in .
// Both this file and observation-hook.js import the same module so
// the audit log and the deny gate see the same write surface.


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

/** @stele:effects */
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

/** @stele:effects */
function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
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

function failClosed(message) {
  process.stderr.write(`${message}\n`);
  process.exit(BLOCK_EXIT_CODE);
}
