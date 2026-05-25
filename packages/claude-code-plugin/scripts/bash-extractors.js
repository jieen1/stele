// Round 13 L-05/P-04: shared bash-target extractors used by both
// `pre-tool-protect.js` (which blocks writes synchronously) and
// `observation-hook.js` (which records writes to the audit log).
//
// Pre-extraction these two files had divergent extractor implementations:
// observation-hook had only redirect / tee / dd / cp-mv-install handlers,
// while pre-tool-protect added git-checkout, interpreter `-c`,
// wrapper-flag peeling (`sudo -u root ...`), `ln`, and 4 more file-op
// commands (`rsync` / `truncate` / `chmod` / `chown`). That meant any
// write made through one of the 8 missing vectors was BLOCKED at
// PreToolUse but INVISIBLE in the observation log, biasing the
// maintenance-summary's view of agent activity.
//
// This module is the single source of truth. Both consumers import
// from here; the dogfood checker `bash_extractors_imported_by_both`
// asserts that neither file re-implements an extractor by name.

import path from "node:path";
import {
  joinContinuationLines,
  parseLiteralShellPath,
  stripShellComment,
  tokenizeShellLine,
} from "./shell-utils.js";

export const COMMAND_SEPARATOR_TOKENS = new Set(["|", "||", "&&", "&", ";"]);

const _INTERPRETER_NAMES = new Set([
  "python", "python3", "node", "nodejs", "perl", "ruby", "bash", "sh", "zsh",
]);

const _SHELL_WRAPPER_NAMES = new Set([
  "env", "command", "exec", "nice", "nohup", "time", "sudo", "doas",
  "busybox", "stdbuf", "ionice", "chronic",
]);

const _INTERPRETER_WRITE_HINTS = [
  ",'w'", ",\"w\"", ",'wb'", ",\"wb\"", ",'a'", ",\"a\"",
  ",'ab'", ",\"ab\"", ",'x'", ",\"x\"", ",'r+'", ",\"r+\"",
  "Path.write_text", "Path.write_bytes",
  "os.remove(", "os.unlink(", "shutil.move(", "shutil.rmtree(",
  "writeFileSync", "appendFileSync", "unlinkSync", "rmSync",
  "fs.write", "fs.unlink", "fs.rm", "fs.appendFile",
];

const _FILE_OP_COMMANDS = new Set([
  "cp", "mv", "install",
  "ln", "rsync", "truncate", "chmod", "chown",
]);

const _REAL_CMD_BASENAMES = new Set([
  "git", "cp", "mv", "ln", "rsync", "install", "truncate", "chmod", "chown",
  "dd", "tee",
]);

/**
 * Top-level: extract every protected-write target from a Bash command
 * string. Handles continuation lines, heredocs, comments. Returns a
 * de-duped array of literal paths (+ any synthetic targets the
 * interpreter extractor surfaces).
 */
/** @stele:effects */
export function extractBashWriteTargets(command) {
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

/** @stele:effects */
export function extractWriteTargetsFromLine(line) {
  if (line.trim().length === 0) {
    return [];
  }
  const tokens = tokenizeShellLine(line);
  return [
    ...extractRedirectTargets(tokens),
    ...extractTeeTargets(tokens),
    ...extractFileOperationTargets(tokens),
    ...extractDdTargets(tokens),
    ...extractGitCheckoutTargets(tokens),
    ...extractInterpreterScriptTargets(tokens, line),
  ];
}

export function extractRedirectTargets(tokens) {
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

/** @stele:effects */
export function extractTeeTargets(tokens) {
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

/** @stele:effects */
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

/** @stele:effects */
export function extractFileOperationTargets(tokens) {
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

/** @stele:effects */
function extractFileOperationTargetsFromSegment(tokens) {
  const wordTokens = tokens.filter((t) => t.type === "word");
  const realCmdIdx = _firstRealCommandIndex(wordTokens);
  if (realCmdIdx < 0) return [];
  const commandToken = wordTokens[realCmdIdx];
  if (!commandToken || !_FILE_OP_COMMANDS.has(path.posix.basename(commandToken.value))) {
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
  // Round 5 J-03: `ln` source AND destination both matter (hardlink
  // creates a shared inode); other commands keep "last = destination".
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

/** @stele:effects */
export function extractDdTargets(tokens) {
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

/** @stele:effects */
function extractDdTargetsFromSegment(tokens) {
  const wordTokens = tokens.filter((t) => t.type === "word");
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

/**
 * Round 4 D-05: `git checkout <file>` / `git restore <file>` overwrite
 * the working tree from history — equivalent to a write for the
 * purpose of protecting `contract/**` etc.
 */
/** @stele:effects */
export function extractGitCheckoutTargets(tokens) {
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

/** @stele:effects */
function extractGitCheckoutFromSegment(tokens) {
  const wordTokens = tokens.filter((t) => t.type === "word");
  if (wordTokens.length < 2) return [];
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
    const literalPath = parseLiteralShellPath(tok.value);
    if (literalPath !== null && (literalPath.includes("/") || literalPath.includes("."))) {
      targets.push(literalPath);
    }
  }
  return targets;
}

/**
 * Round 4 D-05: `python -c "<script>"` / `node -e "<script>"` etc.
 * can write to arbitrary paths from the interpreter body. We can't
 * execute the interpreter, so we surface every quoted path-shaped
 * substring on the line when the body shows write-shaped tokens.
 */
/** @stele:effects */
export function extractInterpreterScriptTargets(tokens, line) {
  const wordTokens = tokens.filter((t) => t.type === "word");
  if (wordTokens.length < 2) return [];
  const realCmdIdx = _firstRealCommandIndex(wordTokens);
  if (realCmdIdx < 0) return [];
  const cmd = path.posix.basename(wordTokens[realCmdIdx].value);
  if (!_INTERPRETER_NAMES.has(cmd)) return [];
  const interpreterFlag = wordTokens.slice(realCmdIdx + 1).find((t) => t.value === "-c" || t.value === "-e");
  if (interpreterFlag === undefined) return [];
  if (!_INTERPRETER_WRITE_HINTS.some(/** @stele:effects */ (hint) => line.includes(hint))) {
    return [];
  }
  return _extractProtectedSubstringsFromLine(line);
}

function _extractProtectedSubstringsFromLine(line) {
  const targets = new Set();
  const quotePatterns = [
    /"([^"\n\r]{1,256})"/g,
    /'([^'\n\r]{1,256})'/g,
    /`([^`\n\r]{1,256})`/g,
  ];
  for (const re of quotePatterns) {
    let match;
    while ((match = re.exec(line)) !== null) {
      const candidate = match[1];
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

/**
 * Round 5 I-04 + Round 6 L-01: peel leading env-prefix assignments
 * (`FOO=bar`) and wrapper commands + their flag arguments
 * (`sudo -u root`, `env -i`, `nice -n 10`, `stdbuf -oL`, ...). Returns
 * the index of the first "real" word-token in `wordTokens`, or -1 if
 * none.
 *
 * The wrapper-flag-and-value heuristic stops consuming when the next
 * token is one of `_REAL_CMD_BASENAMES` or another interpreter — i.e.
 * "if it looks like the actual command, stop peeling."
 */
/** @stele:effects */
export function _firstRealCommandIndex(wordTokens) {
  let i = 0;
  while (i < wordTokens.length) {
    const v = wordTokens[i].value;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
      i += 1;
      continue;
    }
    if (_SHELL_WRAPPER_NAMES.has(path.posix.basename(v))) {
      i += 1;
      while (i < wordTokens.length && wordTokens[i].value.startsWith("-")) {
        i += 1;
        if (
          i < wordTokens.length &&
          !wordTokens[i].value.startsWith("-") &&
          !_INTERPRETER_NAMES.has(path.posix.basename(wordTokens[i].value)) &&
          !_REAL_CMD_BASENAMES.has(path.posix.basename(wordTokens[i].value))
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

/** @stele:effects */
export function extractHeredocDelimiters(line) {
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
