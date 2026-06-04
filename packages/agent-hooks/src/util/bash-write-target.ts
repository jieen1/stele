/**
 * Minimal best-effort extractor for "what file does this bash command write
 * to?". Used by editor adapters that do not expose a structured target path
 * (Cursor, Continue.dev). The richer parser used by the Claude Code plugin
 * lives in `packages/claude-code-plugin/scripts/shell-utils.js` and remains
 * the source of truth for that platform; this helper is intentionally smaller.
 *
 * Supports redirects (> >>), `tee`, and the destination of `cp`/`mv`.
 * Returns `null` when no plausible write target is detected.
 */
export function extractBashWriteTarget(command: string | undefined): string | null {
  if (typeof command !== "string" || command.trim().length === 0) {
    return null;
  }

  const tokens = tokenize(command);

  // Redirect: > target | >> target
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === ">" || token === ">>") {
      const next = tokens[index + 1];
      const literal = parseLiteral(next);
      if (literal !== null) {
        return literal;
      }
    }
  }

  // tee [flags] target...
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "tee") {
      continue;
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor];

      if (value === "--") {
        const literal = parseLiteral(tokens[cursor + 1]);
        if (literal !== null) {
          return literal;
        }
        break;
      }

      if (value?.startsWith("-")) {
        continue;
      }

      const literal = parseLiteral(value);
      if (literal !== null) {
        return literal;
      }
    }
  }

  // cp / mv / install: last positional is destination
  const fileOps = new Set(["cp", "mv", "install"]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!fileOps.has(tokens[index]!)) {
      continue;
    }

    const positional: string[] = [];
    let sawDoubleDash = false;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor]!;
      if (!sawDoubleDash && value === "--") {
        sawDoubleDash = true;
        continue;
      }
      if (!sawDoubleDash && value.startsWith("-")) {
        continue;
      }
      positional.push(value);
    }

    if (positional.length > 0) {
      const literal = parseLiteral(positional[positional.length - 1]);
      if (literal !== null) {
        return literal;
      }
    }
  }

  // rm / rmdir / unlink / shred: deleting a protected file is as damaging as
  // overwriting it. Every positional is a delete target; return the first
  // parseable literal so a protected target is caught (best-effort: this
  // minimal helper returns a single target — the Claude Code plugin's richer
  // extractor checks every arg).
  const deleteOps = new Set(["rm", "rmdir", "unlink", "shred"]);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!deleteOps.has(tokens[index]!)) {
      continue;
    }
    let sawDoubleDash = false;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor]!;
      if (!sawDoubleDash && value === "--") {
        sawDoubleDash = true;
        continue;
      }
      if (!sawDoubleDash && value.startsWith("-")) {
        continue;
      }
      const literal = parseLiteral(value);
      if (literal !== null) {
        return literal;
      }
    }
  }

  return null;
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    // Inside single quotes: literal mode — nothing escapes except the closing '
    if (quote === null) {
      // Single-quote: literal mode (no escape sequences)
      if (char === "'") {
        let end = index + 1;
        while (end < command.length && command[end] !== "'") {
          end += 1;
        }
        current += command.slice(index, end + 1);
        index = end;
        continue;
      }

      // Double-quote: allow backslash escapes
      if (char === '"') {
        quote = '"';
        current += char;
        continue;
      }

      if (/\s/u.test(char!)) {
        pushIfNonEmpty(tokens, current);
        current = "";
        continue;
      }

      const twoChar = command.slice(index, index + 2);
      if (twoChar === ">>") {
        pushIfNonEmpty(tokens, current);
        current = "";
        tokens.push(">>");
        index += 1;
        continue;
      }

      if (char === ">" || char === "<" || char === "|" || char === ";" || char === "&") {
        pushIfNonEmpty(tokens, current);
        current = "";
        tokens.push(char);
        continue;
      }

      current += char;
    } else {
      // Inside double quotes: backslash-escapes \", \\, \$, \`, \!
      if (char === "\\" && index + 1 < command.length) {
        const next = command[index + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "!") {
          current += char + next;
          index += 1;
          continue;
        }
      }
      if (char === '"') {
        current += char;
        quote = null;
      } else {
        current += char;
      }
    }
  }

  pushIfNonEmpty(tokens, current);
  return tokens;
}

function pushIfNonEmpty(tokens: string[], value: string): void {
  if (value.length > 0) {
    tokens.push(value);
  }
}

function parseLiteral(token: string | undefined): string | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }

  let value = token;
  const isQuoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (isQuoted) {
    value = value.slice(1, -1);
  }

  if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
    return null;
  }

  // On Windows, normalize backslashes to forward slashes for comparison
  if (process.platform === "win32" && value.includes("\\")) {
    value = value.replaceAll("\\", "/");
  } else if (value.includes("\\")) {
    // On Unix, a lone backslash in a path is suspicious — reject to be safe
    return null;
  }

  if (/[$`*?[\]{}()|&;]/u.test(value)) {
    return null;
  }

  return value;
}
