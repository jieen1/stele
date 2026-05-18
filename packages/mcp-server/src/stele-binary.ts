import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFile, type ExecFileOptions } from "node:child_process";
import { sanitizeError } from "./error-sanitizer.js";

/** Expected @stele/cli version. Must match the installed dependency. */
const EXPECTED_CLI_VERSION = "0.1.0";

/**
 * Workspace root bound. When set, all binary resolution is constrained
 * to node_modules within this workspace root.
 */
let workspaceRoot: string | null = null;

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
 * Verify a single package.json for identity and version.
 * Rejects symlinks, checks name === "@stele/cli", enforces matching version.
 */
function verifyPackageJson(pkgPath: string): boolean {
  try {
    const lstats = lstatSync(pkgPath);
    if (lstats.isSymbolicLink()) {
      return false;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name !== "@stele/cli") {
      return false;
    }
    // Version check: reject if version doesn't match expected
    if (pkg.version !== EXPECTED_CLI_VERSION) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify the binary belongs to the legitimate @stele/cli package.
 * Checks package.json identity, rejects symlinks, validates version.
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

  // Check the @stele/cli package directly in node_modules
  // (sibling of .bin directory)
  const nodeModulesDir = resolve(binaryPath, "..", "..");
  const cliPkgPath = resolve(nodeModulesDir, "@stele", "cli", "package.json");
  if (existsSync(cliPkgPath) && verifyPackageJson(cliPkgPath)) {
    return true;
  }

  // Walk up to find the package.json for @stele/cli
  let dir = resolve(binaryPath, "..", "..");
  for (let depth = 0; depth < 10; depth += 1) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath) && verifyPackageJson(pkgPath)) {
      return true;
    }
    dir = resolve(dir, "..");
  }

  return false;
}

/**
 * Sanitize CLI stdout to prevent information leakage.
 * Applies the same redaction patterns as error sanitization.
 */
function sanitizeOutput(output: string): string {
  return sanitizeError(output);
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
          resolve(sanitizeOutput(stdout));
        }
      });
    } else {
      execFile(binary, args, execOpts, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(new Error(stderr?.trim() ?? `stele command failed`), { code: error.code, signal: error.signal }));
        } else {
          resolve(sanitizeOutput(stdout));
        }
      });
    }
  });
}

/**
 * Set the workspace root for this MCP server instance.
 * All binary resolution is constrained to this root — parent traversal
 * cannot escape above it. Call during server initialization.
 */
export function setWorkspaceRoot(root: string): void {
  workspaceRoot = resolve(root);
  clearBinaryCache();
}

/**
 * Get the workspace root, or null if not set.
 */
export function getWorkspaceRoot(): string | null {
  return workspaceRoot;
}

/**
 * Canonicalize a path via realpath. Returns original on failure.
 */
function tryRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Check if a resolved directory is within the workspace root.
 * Returns true if `dir` is under (or equal to) the workspace root.
 */
function isWithinWorkspaceRoot(dir: string): boolean {
  if (workspaceRoot === null) {
    return true; // No root set = no constraint
  }
  const dirReal = tryRealpath(dir);
  const rootReal = tryRealpath(workspaceRoot);
  if (dirReal === dir && rootReal === workspaceRoot) {
    // Neither is realpath-able; fall back to logical comparison
    if (dir === workspaceRoot) return true;
    return dir.startsWith(workspaceRoot + "/");
  }
  const target = (dirReal !== dir) ? dirReal : dir;
  const bound = (rootReal !== workspaceRoot) ? rootReal : workspaceRoot;
  if (target === bound) return true;
  return target.startsWith(bound + "/");
}

/**
 * Resolve the local @stele/cli binary, with package identity verification.
 *
 * Priority:
 * 1. node_modules/.bin/stele (verified)
 * 2. node_modules/@stele/cli/dist/index.js (verified)
 * 3. Parent directory node_modules (up to 3 levels, verified, workspace-bound)
 * 4. Returns null if nothing found
 */
export function resolveSteleBinary(cwd: string): string | null {
  // Canonicalize cwd via realpath for cache key stability
  const realCwd = tryRealpath(cwd);

  // Check cache with staleness detection
  if (cachedBinary !== null && cachedCwd === realCwd) {
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

  const binName = process.platform === "win32" ? "stele.cmd" : "stele";

  // Check node_modules/.bin/stele
  const binPath = resolve(realCwd, "node_modules", ".bin", binName);
  if (existsSync(binPath) && verifyPackageIdentity(binPath)) {
    cachedBinary = binPath;
    cachedCwd = realCwd;
    cachedMtime = statSync(binPath).mtimeMs;
    return binPath;
  }

  // Check @stele/cli dist/index.js directly
  const cliPath = resolve(realCwd, "node_modules", "@stele", "cli", "dist", "index.js");
  if (existsSync(cliPath)) {
    // For direct path, verify package.json
    const pkgPath = resolve(realCwd, "node_modules", "@stele", "cli", "package.json");
    if (existsSync(pkgPath) && verifyPackageIdentity(pkgPath)) {
      cachedBinary = cliPath;
      cachedCwd = realCwd;
      cachedMtime = statSync(cliPath).mtimeMs;
      return cliPath;
    }
  }

  // Check parent directories up to 3 levels, constrained by workspace root
  for (let depth = 1; depth <= 3; depth += 1) {
    const parent = resolve(realCwd, ...Array(depth).fill(".."));

    // Workspace root bound: stop if parent is above workspace root
    if (!isWithinWorkspaceRoot(parent)) {
      break;
    }

    const parentBin = resolve(parent, "node_modules", ".bin", binName);
    if (existsSync(parentBin) && verifyPackageIdentity(parentBin)) {
      cachedBinary = parentBin;
      cachedCwd = realCwd;
      cachedMtime = statSync(parentBin).mtimeMs;
      return parentBin;
    }
    const parentCli = resolve(parent, "node_modules", "@stele", "cli", "dist", "index.js");
    const parentPkg = resolve(parent, "node_modules", "@stele", "cli", "package.json");
    if (existsSync(parentCli) && existsSync(parentPkg) && verifyPackageIdentity(parentPkg)) {
      cachedBinary = parentCli;
      cachedCwd = realCwd;
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
