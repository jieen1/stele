import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFile, type ExecFileOptions } from "node:child_process";

/** Cache for resolved binary path. */
let cachedBinary: string | null = null;
let cachedCwd: string | null = null;
let cachedMtime: number | null = null;

/** Default options for stele CLI execution. */
const DEFAULT_EXEC_OPTIONS: { encoding: BufferEncoding; maxBuffer: number } = {
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
};

/** Default timeout for CLI invocations (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum allowed length for a single CLI argument. */
const MAX_ARG_LENGTH = 4096;

/** Characters that must not appear in CLI arguments (injection vectors). */
const FORBIDDEN_ARG_CHARS = /\0|\r|\n/u;

/**
 * Validate that CLI arguments are safe to pass to the stele binary.
 * Rejects arguments containing newlines, null bytes, or excessive length.
 */
function validateArgs(args: string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (FORBIDDEN_ARG_CHARS.test(arg)) {
      throw new Error(`Invalid character in argument ${i}: newlines and null bytes are not allowed`);
    }
    if (arg.length > MAX_ARG_LENGTH) {
      throw new Error(`Argument ${i} exceeds maximum length of ${MAX_ARG_LENGTH} characters`);
    }
  }
}

/**
 * Verify the binary belongs to the legitimate @stele/cli package.
 * Checks package.json identity, rejects symlinks, and validates the package directory.
 */
export function verifyPackageIdentity(binaryPath: string): boolean {
  // Reject symlinks to prevent supply chain bypass
  try {
    const lstats = lstatSync(binaryPath);
    if (lstats.isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }

  // Walk up to find the package.json for @stele/cli
  try {
    let dir = resolve(binaryPath, "..", "..");
    for (let depth = 0; depth < 10; depth += 1) {
      const pkgPath = resolve(dir, "package.json");
      // Use readFileSync directly in try/catch — no TOCTOU vs existsSync
      try {
        // Reject symlinks on package.json
        const lstats = lstatSync(pkgPath);
        if (lstats.isSymbolicLink()) {
          dir = resolve(dir, "..");
          continue;
        }

        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "@stele/cli") {
          return true;
        }
      } catch {
        // ENOENT or parse error — not the right package, continue walking
        dir = resolve(dir, "..");
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }

}

/**
 * Execute the local stele CLI with given arguments.
 * Async — does NOT block the event loop.
 * Requires local installation — does NOT fall back to npx.
 */
export async function runStele(cwd: string, args: string[], options: Partial<ExecFileOptions> = {}): Promise<string> {
  // Validate arguments before passing to child process
  validateArgs(args);

  const binary = resolveSteleBinary(cwd);

  if (binary === null) {
    throw new Error(
      "Cannot execute stele: no local installation found. " +
        "Install @stele/cli in the project directory or set STELE_BIN environment variable."
    );
  }

  const execOpts: { encoding: BufferEncoding; maxBuffer: number; cwd: string; timeout: number } = {
    ...DEFAULT_EXEC_OPTIONS,
    cwd,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
  };

  return new Promise((resolve, reject) => {
    // Run via node for .js files, direct exec for .cmd/.sh
    if (binary.endsWith(".js")) {
      execFile("node", [binary, ...args], execOpts, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(stderr?.trim() ?? `stele command failed`), { code: error.code, signal: error.signal }));
        } else {
          resolve(stdout);
        }
      });
    } else {
      execFile(binary, args, execOpts, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(stderr?.trim() ?? `stele command failed`), { code: error.code, signal: error.signal }));
        } else {
          resolve(stdout);
        }
      });
    }
  });
}

/**
 * Resolve the local @stele/cli binary, with package identity verification.
 *
 * Priority:
 * 1. node_modules/.bin/stele (verified)
 * 2. node_modules/@stele/cli/dist/index.js (verified)
 * 3. Parent directory node_modules (up to 3 levels, verified)
 * 4. Returns null if nothing found
 */
export function resolveSteleBinary(cwd: string): string | null {
  // Check cache with staleness detection
  if (cachedBinary !== null && cachedCwd === cwd) {
    // Verify cached file still exists and hasn't been modified
    try {
      const stats = statSync(cachedBinary);
      if (cachedMtime !== null && stats.mtimeMs === cachedMtime) {
        return cachedBinary;
      }
      // File changed — clear cache and re-resolve
    } catch {
      // File was removed — clear cache
    }
    clearBinaryCache();
  }

  // Check node_modules/.bin/stele
  const binPath = resolve(cwd, "node_modules", ".bin", process.platform === "win32" ? "stele.cmd" : "stele");
  if (existsSync(binPath) && verifyPackageIdentity(binPath)) {
    cachedBinary = binPath;
    cachedCwd = cwd;
    cachedMtime = statSync(binPath).mtimeMs;
    return binPath;
  }

  // Check @stele/cli dist/index.js directly
  const cliPath = resolve(cwd, "node_modules", "@stele", "cli", "dist", "index.js");
  if (existsSync(cliPath)) {
    // For direct path, verify package.json
    const pkgPath = resolve(cwd, "node_modules", "@stele", "cli", "package.json");
    if (existsSync(pkgPath) && verifyPackageIdentity(pkgPath)) {
      cachedBinary = cliPath;
      cachedCwd = cwd;
      cachedMtime = statSync(cliPath).mtimeMs;
      return cliPath;
    }
  }

  // Check parent directories up to 3 levels
  for (let depth = 1; depth <= 3; depth += 1) {
    const parent = resolve(cwd, "..".repeat(depth));
    const parentBin = resolve(parent, "node_modules", ".bin", process.platform === "win32" ? "stele.cmd" : "stele");
    if (existsSync(parentBin) && verifyPackageIdentity(parentBin)) {
      cachedBinary = parentBin;
      cachedCwd = cwd;
      cachedMtime = statSync(parentBin).mtimeMs;
      return parentBin;
    }
    const parentCli = resolve(parent, "node_modules", "@stele", "cli", "dist", "index.js");
    const parentPkg = resolve(parent, "node_modules", "@stele", "cli", "package.json");
    if (existsSync(parentCli) && existsSync(parentPkg) && verifyPackageIdentity(parentPkg)) {
      cachedBinary = parentCli;
      cachedCwd = cwd;
      cachedMtime = statSync(parentCli).mtimeMs;
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
  cachedMtime = null;
}
