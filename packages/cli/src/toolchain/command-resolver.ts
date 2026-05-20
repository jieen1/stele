// Command resolver — resolves project-local commands (tsc, eslint, etc.)
// from node_modules/.bin or package manager exec wrappers before falling
// back to PATH.

import { accessSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform } from "node:os";

export interface ResolvedCommand {
  /** The executable to pass to execFile (e.g., absolute path, or "pnpm"). */
  command: string;
  /** Arguments to pass to execFile (excluding the original command name). */
  args: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a shell command string into an executable path + arguments.
 *
 * Resolution order:
 *   1. node_modules/.bin/<cmd> (and .cmd on Windows)
 *   2. Package manager exec (pnpm exec, npm exec, yarn dx)
 *   3. Original command (PATH fallback)
 */
export function resolveCommand(
  cmd: string,
  projectDir: string,
): ResolvedCommand {
  const parts = parseShellCommand(cmd);
  const name = parts.command;

  // Try local node_modules/.bin first
  const localPath = findLocalExecutable(name, projectDir);
  if (localPath) {
    return { command: localPath, args: parts.args };
  }

  // Try package manager exec wrappers
  const wrapper = findPackageWrapper(projectDir);
  if (wrapper) {
    return {
      command: wrapper.executable,
      args: [...wrapper.args, name, ...parts.args],
    };
  }

  // Fallback: use the command as-is (PATH lookup).
  return { command: name, args: parts.args };
}

// ---------------------------------------------------------------------------
// Local executable lookup
// ---------------------------------------------------------------------------

/**
 * Find a local executable in node_modules/.bin or via package manager.
 * Returns the absolute path to the executable, or undefined.
 */
export function findLocalExecutable(
  name: string,
  projectDir: string,
): string | undefined {
  // Walk up from projectDir to find node_modules/.bin (handles monorepos)
  let current = projectDir;
  const seen = new Set<string>();

  while (current !== dirname(current) && !seen.has(current)) {
    seen.add(current);
    const binDir = join(current, "node_modules", ".bin");

    // On Windows, try .cmd suffix first (it exists alongside the Unix script)
    if (platform() === "win32") {
      const cmdPath = join(binDir, name + ".cmd");
      if (isExecutable(cmdPath)) return cmdPath;
    }

    // Try the plain name (Unix scripts, or symlinks)
    const plainPath = join(binDir, name);
    if (isExecutable(plainPath)) return plainPath;

    // On Windows, also try .bat and .exe
    if (platform() === "win32") {
      for (const ext of [".bat", ".exe"]) {
        const altPath = join(binDir, name + ext);
        if (isExecutable(altPath)) return altPath;
      }
    }

    current = dirname(current);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Package manager detection
// ---------------------------------------------------------------------------

/**
 * Detect the package manager by looking for lockfiles, then check if
 * the executable is available. Returns a wrapper config or undefined.
 */
function findPackageWrapper(
  projectDir: string,
): { executable: string; args: string[] } | undefined {
  const lockDir = projectDir;

  // Priority order: pnpm > npm > yarn (matches common monorepo preferences)
  if (existsSync(join(lockDir, "pnpm-lock.yaml"))) {
    if (isCommandAvailable("pnpm")) {
      return { executable: "pnpm", args: ["exec"] };
    }
  }

  if (existsSync(join(lockDir, "package-lock.json"))) {
    if (isCommandAvailable("npm")) {
      return { executable: "npm", args: ["exec"] };
    }
  }

  if (existsSync(join(lockDir, "yarn.lock"))) {
    if (isCommandAvailable("yarn")) {
      return { executable: "yarn", args: ["dx"] };
    }
  }

  // No lockfile found — try npm as a common default
  if (isCommandAvailable("npm")) {
    return { executable: "npm", args: ["exec"] };
  }

  return undefined;
}

/**
 * Check if a command is available on PATH.
 */
function isCommandAvailable(command: string): boolean {
  // Quick check: try to access the command. On Windows we also check .exe/.cmd/.bat
  const envPath = process.env.PATH;
  if (!envPath) return false;

  const isWin = platform() === "win32";
  const extensions = isWin ? [".COM", ".EXE", ".BAT", ".CMD"] : [""];

  for (const dir of envPath.split(isWin ? ";" : ":")) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        if (accessSync(candidate) === undefined) return true;
      } catch {
        // Not found in this directory
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a file exists and is executable.
 */
function isExecutable(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a shell command string into { command, args }.
 * Handles double-quoted and single-quoted arguments.
 */
export function parseShellCommand(cmd: string): { command: string; args: string[] } {
  const tokens = splitShellTokens(cmd);
  if (tokens.length === 0) {
    return { command: cmd.trim(), args: [] };
  }
  return { command: tokens[0], args: tokens.slice(1) };
}

/**
 * Split a shell command string into tokens, respecting quotes.
 */
function splitShellTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (ch === " " || ch === "\t") {
      if (inSingleQuote || inDoubleQuote) {
        current += ch;
      } else if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
