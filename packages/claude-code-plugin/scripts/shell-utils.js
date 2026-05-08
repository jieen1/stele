// Shared shell parsing utilities for Stele plugin hooks.
// Both pre-tool-protect and observation-hook need to parse shell
// commands to extract file paths from redirects, tee, cp, mv, and dd.

export function joinContinuationLines(lines) {
  const joined = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (joined.length > 0 && shouldContinueLine(joined[joined.length - 1], line)) {
      joined[joined.length - 1] += line;
    } else {
      joined.push(line);
    }
  }

  return joined;
}

export function shouldContinueLine(previous, current) {
  let quote = null;
  let escaped = false;

  for (let index = 0; index < previous.length; index += 1) {
    const char = previous[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      if (quote !== null) {
        escaped = true;
      } else {
        return shouldStartNewLine(current);
      }

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

    if (char === "#") {
      return false;
    }
  }

  return false;
}

export function shouldStartNewLine(line) {
  return line.trim().length > 0;
}

export function stripShellComment(line) {
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

export function startsShellComment(line, index) {
  if (index === 0) {
    return true;
  }

  return /[\s;|&()]/u.test(line[index - 1] ?? "");
}

export function tokenizeShellLine(line) {
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

    if (twoChar === ">>" || twoChar === "||" || twoChar === "&&" || twoChar === "<<") {
      pushWordToken(tokens, current);
      current = "";
      tokens.push({ type: "operator", value: twoChar });
      index += 1;
      continue;
    }

    if (char === ">" || char === "|" || char === ";" || char === "<" || char === "&") {
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

export function parseLiteralShellPath(token) {
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
    candidate.includes("\\") ||
    /[$`*?[\]{}()|&;]/u.test(candidate) ||
    candidate.includes("\n") ||
    candidate.includes("\r")
  ) {
    return null;
  }

  return candidate;
}
