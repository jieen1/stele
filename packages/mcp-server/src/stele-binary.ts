import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, type ExecFileOptions } from "node:child_process";

/** Cache for resolved binary path. */
let cachedBinary: string | null = null;
let cachedCwd: string | null = null;

/** Default options for stele CLI execution. */
const DEFAULT_EXEC_OPTIONS: ExecFileOptions & { encoding: BufferEncoding; maxBuffer: number } = {
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
};

/**
 * Execute the local stele CLI with given arguments.
 * Resolves the local binary first; falls back to npx only when no local install exists.
 */
export function runStele(cwd: string, args: string[], options: Partial<ExecFileOptions> = {}): string {
  const binary = resolveSteleBinary(cwd);

  if (binary !== null) {
    // Local binary found: run via node (for .js) or direct exec (for .cmd/.sh)
    if (binary.endsWith(".js")) {
      return execFileSync("node", [binary, ...args], {
        ...DEFAULT_EXEC_OPTIONS,
        cwd,
        ...options,
      });
    }

    return execFileSync(binary, args, {
      ...DEFAULT_EXEC_OPTIONS,
      cwd,
      ...options,
    });
  }

  // No local binary: fall back to npx (still works, but less secure)
  return execFileSync("npx", ["stele", ...args], {
    ...DEFAULT_EXEC_OPTIONS,
    cwd,
    ...options,
  });
}

/**
 * Resolve the local @stele/cli binary, avoiding npx supply chain risk.
 *
 * Priority:
 * 1. node_modules/.bin/stele
 * 2. node_modules/@stele/cli/dist/index.js
 * 3. Parent directory node_modules (up to 3 levels)
 * 4. Returns null if nothing found
 */
export function resolveSteleBinary(cwd: string): string | null {
  if (cachedBinary !== null && cachedCwd === cwd) {
    return cachedBinary;
  }

  // Check node_modules/.bin/stele
  const binPath = resolve(cwd, "node_modules", ".bin", process.platform === "win32" ? "stele.cmd" : "stele");
  if (existsSync(binPath)) {
    cachedBinary = binPath;
    cachedCwd = cwd;
    return binPath;
  }

  // Check @stele/cli dist/index.js directly
  const cliPath = resolve(cwd, "node_modules", "@stele", "cli", "dist", "index.js");
  if (existsSync(cliPath)) {
    cachedBinary = cliPath;
    cachedCwd = cwd;
    return cliPath;
  }

  // Check parent directories up to 3 levels
  for (let depth = 1; depth <= 3; depth += 1) {
    const parent = resolve(cwd, "..".repeat(depth));
    const parentBin = resolve(parent, "node_modules", ".bin", process.platform === "win32" ? "stele.cmd" : "stele");
    if (existsSync(parentBin)) {
      cachedBinary = parentBin;
      cachedCwd = cwd;
      return parentBin;
    }
    const parentCli = resolve(parent, "node_modules", "@stele", "cli", "dist", "index.js");
    if (existsSync(parentCli)) {
      cachedBinary = parentCli;
      cachedCwd = cwd;
      return parentCli;
    }
  }

  return null;
}

/**
 * Clear the cached binary path. Call after package install or directory change.
 */
export function clearBinaryCache(): void {
  cachedBinary = null;
  cachedCwd = null;
}
