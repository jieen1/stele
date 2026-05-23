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
  "contract/design/approvals/**/*",
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
  // Round 4 E-09: supply-chain shape (kept byte-equal with cli/core).
  "pnpm-lock.yaml",
  "package.json",
  "packages/*/package.json",
  "packages/*/tsup.config.ts",
  ".github/workflows/**",
  "scripts/publish-npm.mjs",
  "scripts/verify-packed-adoption.mjs",
];

// Round 4 D-05: hoisted constants used by extractInterpreterScriptTargets.
// Defined here so the function — which is invoked during the early
// extractTargetPaths call — sees fully-initialised values rather than a
// TDZ binding.
const _INTERPRETER_NAMES = new Set([
  "python", "python3", "node", "nodejs", "perl", "ruby", "bash", "sh", "zsh",
]);
// Round 5 I-04: wrapper-command names to peel before the real command.
const _SHELL_WRAPPER_NAMES = new Set([
  "env", "command", "exec", "nice", "nohup", "time", "sudo", "doas",
  "busybox", "stdbuf", "ionice", "chronic",
]);

const _INTERPRETER_WRITE_HINTS = [
  // Python: open(..., 'w') / 'wb' / 'a' / 'ab' / 'x' / 'r+' — the mode
  // argument is the unambiguous write signal. We deliberately don't
  // match a bare `open(` since reads use `open('x').read()`.
  ",'w'", ",\"w\"", ",'wb'", ",\"wb\"", ",'a'", ",\"a\"",
  ",'ab'", ",\"ab\"", ",'x'", ",\"x\"", ",'r+'", ",\"r+\"",
  "Path.write_text", "Path.write_bytes",
  "os.remove(", "os.unlink(", "shutil.move(", "shutil.rmtree(",
  // Node.js
  "writeFileSync", "appendFileSync", "unlinkSync", "rmSync",
  "fs.write", "fs.unlink", "fs.rm", "fs.appendFile",
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
    // Round 4 D-05: additional bash bypass vectors.
    ...extractGitCheckoutTargets(tokens),
    ...extractInterpreterScriptTargets(tokens, line),
  ];
}

/**
 * Round 4 D-05: `git checkout <file>` and `git restore <file>` overwrite
 * the working-tree file from history. An agent that wants to undo a
 * protected change can `git checkout HEAD -- contract/main.stele`.
 * Tokens look like: word("git") word("checkout"|"restore") word(<file>...)
 * or with -- separator. We treat every positional arg after the
 * subcommand as a potential target.
 */
function extractGitCheckoutTargets(tokens) {
  const targets = [];
  let segmentStart = 0;
  for (let i = 0; i <= tokens.length; i += 1) {
    const t = tokens[i];
    if (i === tokens.length || (t.type === "operator" && COMMAND_SEPARATOR_TOKENS.has(t.value))) {
      targets.push(...extractGitCheckoutFromSegment(tokens.slice(segmentStart, i)));
      segmentStart = i + 1;
    }
  }
  return targets;
}

function extractGitCheckoutFromSegment(tokens) {
  const wordTokens = tokens.filter((t) => t.type === "word");
  if (wordTokens.length < 2) return [];
  // Round 5 I-04: peel env-prefix and wrappers (env/command/exec/nice/
  // nohup/time/sudo/doas/busybox/stdbuf) before checking for `git`.
  const realCmdIdx = _firstRealCommandIndex(wordTokens);
  if (realCmdIdx < 0) return [];
  if (path.posix.basename(wordTokens[realCmdIdx].value) !== "git") return [];
  if (wordTokens.length <= realCmdIdx + 1) return [];
  const sub = wordTokens[realCmdIdx + 1].value;
  if (sub !== "checkout" && sub !== "restore") return [];
  const targets = [];
  let sawDoubleDash = false;
  for (const tok of wordTokens.slice(realCmdIdx + 2)) {
    if (!sawDoubleDash && tok.value === "--") {
      sawDoubleDash = true;
      continue;
    }
    if (!sawDoubleDash && tok.value.startsWith("-")) {
      continue;
    }
    // Skip refspecs / branch names (no slash or dot is ambiguous; we
    // err on the side of including them — false positives only block
    // an agent's "restore from history" of a clean file).
    const literalPath = parseLiteralShellPath(tok.value);
    if (literalPath !== null && (literalPath.includes("/") || literalPath.includes("."))) {
      targets.push(literalPath);
    }
  }
  return targets;
}

/**
 * Round 4 D-05: detect `python -c "<script>"`, `python3 -c …`, `node -e
 * "<script>"`, `bash -c "<script>"`, `perl -e "<script>"`. The target
 * embedded inside the script body cannot be reliably parsed without
 * executing the interpreter, but we can scan the raw `line` for any
 * substring matching a protected glob's literal prefix; that catches the
 * pathological `python -c "open('.stele/stop-state.json','w')"` case
 * without trying to be a shell-aware interpreter.
 *
 * To avoid false positives on harmless reads (`python -c "open('
 * contract/.manifest.json').read()"`), this extractor only fires when
 * the script body contains BOTH the protected substring AND a
 * write-shaped token like `'w'`, `"w"`, `'wb'`, `>>>` (Python `truncate`),
 * `fs.writeFileSync`, `os.remove`, `unlink`, etc.
 */
function extractInterpreterScriptTargets(tokens, line) {
  const wordTokens = tokens.filter((t) => t.type === "word");
  if (wordTokens.length < 2) return [];
  // Round 5 I-04: an agent can hide the interpreter behind env-prefix
  // assignments (`FOO=bar python3 -c …`) or wrappers (`env`/`command`/
  // `exec`/`nice`/`nohup`/`time`/`sudo`/`doas`/`busybox`/`stdbuf`).
  // Skip those before we look up the command.
  const realCmdIdx = _firstRealCommandIndex(wordTokens);
  if (realCmdIdx < 0) return [];
  const cmd = path.posix.basename(wordTokens[realCmdIdx].value);
  if (!_INTERPRETER_NAMES.has(cmd)) return [];
  // Check that `-c` or `-e` is present in the args.
  const interpreterFlag = wordTokens.slice(realCmdIdx + 1).find((t) => t.value === "-c" || t.value === "-e");
  if (interpreterFlag === undefined) return [];
  // Determine whether the script body looks like a write.
  if (!_INTERPRETER_WRITE_HINTS.some((hint) => line.includes(hint))) {
    return [];
  }
  // Surface the entire line as a "synthetic target" — the caller will
  // match it against protected globs via matchProtectedPath. To make
  // glob matching meaningful we use a placeholder filename and rely on
  // the downstream protected-list matcher knowing about substrings.
  // Concretely: emit every protected-glob literal we can spot in the
  // line as a candidate. The match step then deny-lists any actual hit.
  return _extractProtectedSubstringsFromLine(line);
}

/**
 * Pull every quoted string literal out of `line` (any of `"..."`, `'...'`,
 * or backtick-quoted) that looks like a file path. The caller passes
 * these to `matchProtectedPath` like any other write target — so when a
 * literal matches a protected glob the hook denies. Conservative: only
 * captures values inside quotes, so unquoted identifiers are ignored.
 */
function _extractProtectedSubstringsFromLine(line) {
  const targets = new Set();
  // Scan each quote type separately so a nested mix of `"..."` containing
  // `'...'` (the common interpreter -c pattern) doesn't cause the regex
  // to terminate the inner capture on the wrong quote.
  const quotePatterns = [
    /"([^"\n\r]{1,256})"/g,
    /'([^'\n\r]{1,256})'/g,
    /`([^`\n\r]{1,256})`/g,
  ];
  for (const re of quotePatterns) {
    let match;
    while ((match = re.exec(line)) !== null) {
      const candidate = match[1];
      // Path-shape filter: must contain a slash or a dot, no shell or
      // template metachars, and reasonable length.
      if (
        candidate.length > 0 &&
        candidate.length < 256 &&
        (candidate.includes("/") || candidate.includes(".")) &&
        !/[\s()$;|&]/.test(candidate)
      ) {
        targets.add(candidate);
      }
    }
  }
  return [...targets];
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

/**
 * Round 5 I-04: peel leading env-prefix assignments (`FOO=bar`) and
 * wrapper commands (`env`, `command`, `exec`, `nice`, `nohup`, `time`,
 * `sudo`, `doas`, `busybox`, `stdbuf`) before identifying the real
 * command. Returns the index of the first "real" word-token, or -1
 * when no candidate exists.
 *
 * `_SHELL_WRAPPER_NAMES` is defined near the top of the file alongside
 * `_INTERPRETER_NAMES` to avoid the TDZ pitfall — the helper below is
 * invoked from extractor functions that run early in the hook lifecycle.
 */
function _firstRealCommandIndex(wordTokens) {
  // Round 6 L-01 fix: track whether we just consumed a wrapper so we
  // know to also skip the wrapper's own flag arguments (and their
  // values, if any). Pre-L-01 the helper returned `i` at the first flag
  // following a wrapper — e.g. `sudo -u root python3 -c …` returned
  // idx=1 (`-u`), which then failed the interpreter/file-op/git
  // basename check and skipped the whole segment.
  let i = 0;
  while (i < wordTokens.length) {
    const v = wordTokens[i].value;
    // env-prefix assignment: NAME=value (NAME starts with letter or _).
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
      i += 1;
      continue;
    }
    // Wrapper command: skip the wrapper token, plus any subsequent
    // flag tokens (and the value following a flag-with-value like
    // `sudo -u <user>` / `nice -n <num>` / `env -i`). The flag-value
    // heuristic: a flag whose value isn't a dash-prefixed token gets
    // consumed together.
    if (_SHELL_WRAPPER_NAMES.has(path.posix.basename(v))) {
      i += 1;
      // Consume the wrapper's flag arguments. We're conservative —
      // consume any token starting with `-`, plus the immediate
      // following non-flag token (which is typically the flag's
      // value). This handles `sudo -u user`, `nice -n 10`, `env -i`,
      // `stdbuf -oL`, `time -p`, etc.
      while (i < wordTokens.length && wordTokens[i].value.startsWith("-")) {
        i += 1;
        // The next token may be the flag's value (no `-`); peek
        // and consume if it doesn't look like a command itself.
        if (
          i < wordTokens.length &&
          !wordTokens[i].value.startsWith("-") &&
          !_INTERPRETER_NAMES.has(path.posix.basename(wordTokens[i].value)) &&
          path.posix.basename(wordTokens[i].value) !== "git" &&
          path.posix.basename(wordTokens[i].value) !== "cp" &&
          path.posix.basename(wordTokens[i].value) !== "mv" &&
          path.posix.basename(wordTokens[i].value) !== "ln" &&
          path.posix.basename(wordTokens[i].value) !== "rsync" &&
          path.posix.basename(wordTokens[i].value) !== "install" &&
          path.posix.basename(wordTokens[i].value) !== "truncate" &&
          path.posix.basename(wordTokens[i].value) !== "chmod" &&
          path.posix.basename(wordTokens[i].value) !== "chown" &&
          path.posix.basename(wordTokens[i].value) !== "dd" &&
          path.posix.basename(wordTokens[i].value) !== "tee"
        ) {
          i += 1;
        }
      }
      continue;
    }
    return i;
  }
  return -1;
}

function extractFileOperationTargets(tokens) {
  const targets = [];
  // Round 4 D-05: extend beyond cp/mv/install. Each of these can write or
  // replace a target file, so when the target falls under a protected
  // pattern the hook must intercept the Bash invocation just like a
  // direct Write tool call.
  const commands = new Set([
    "cp", "mv", "install",
    "ln",       // ln / ln -s — symlink swap is the classic protected-file bypass
    "rsync",    // rsync writes to a destination
    "truncate", // truncate -s 0 file
    "chmod",    // metadata mutation on protected files is just as bad as a content edit
    "chown",
  ]);
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
  // Round 5 I-04: peel env-prefix + wrappers before identifying the
  // first real command (`FOO=bar cp ... contract/main.stele` was
  // previously invisible because basename("FOO=bar") is not in
  // `commands`).
  const wordTokens = tokens.filter((t) => t.type === "word");
  const realCmdIdx = _firstRealCommandIndex(wordTokens);
  if (realCmdIdx < 0) return [];
  const commandToken = wordTokens[realCmdIdx];

  if (!commandToken || !commands.has(path.posix.basename(commandToken.value))) {
    return [];
  }

  const targets = [];
  const positionalArgs = [];
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

    positionalArgs.push(token);
  }

  // Round 5 J-03: for `ln`, both source AND destination matter — a
  // hardlink from a protected source to a non-protected destination
  // still creates a shared-inode alias that lets the agent mutate
  // the protected file via the alias. Treat all positional args as
  // candidate targets for `ln`; for the other commands keep the
  // legacy "last positional is the destination" rule.
  if (path.posix.basename(commandToken.value) === "ln") {
    for (const tok of positionalArgs) {
      const literalPath = parseLiteralShellPath(tok.value);
      if (literalPath !== null) {
        targets.push(literalPath);
      }
    }
  } else if (positionalArgs.length > 0) {
    const lastToken = positionalArgs[positionalArgs.length - 1];
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
