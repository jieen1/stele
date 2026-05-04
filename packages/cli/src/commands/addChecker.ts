import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { loadConfig } from "../config/loadConfig.js";

const CHECKER_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHECKER_STUB = `def check(inputs: dict) -> dict:
    return {
        "passed": False,
        "message": "Checker implementation has not been approved yet.",
        "context": inputs,
    }
`;

export async function runAddChecker(projectDir: string, checkerId: string): Promise<void> {
  if (!CHECKER_ID_PATTERN.test(checkerId)) {
    throw new Error(
      `Invalid checker id "${checkerId}". Checker ids must match ${CHECKER_ID_PATTERN} so they stay valid CDL identifiers and Python filenames.`,
    );
  }

  const config = await loadConfig(projectDir);
  const checkerImplDir = resolve(projectDir, config.checkerImplDir);
  await ensureSafeCheckerImplDirectory(projectDir, checkerImplDir, config.checkerImplDir);
  const checkerPath = resolve(checkerImplDir, `${checkerId}.py`);

  await mkdir(dirname(checkerPath), { recursive: true });

  try {
    await writeFile(checkerPath, CHECKER_STUB, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Checker implementation "${checkerId}" already exists at ${checkerPath}.`);
    }

    throw error;
  }

  process.stdout.write(`(checker ${checkerId}\n  (description "TODO: describe what this checker validates."))\n`);
}

async function ensureSafeCheckerImplDirectory(projectDir: string, checkerImplDir: string, configPath: string): Promise<void> {
  try {
    const stats = await lstat(checkerImplDir);

    if (stats.isSymbolicLink()) {
      throw new Error(`Config checkerImplDir "${configPath}" must not be a symlink or junction.`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Config checkerImplDir "${configPath}" must resolve to a regular directory inside the project root.`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    await mkdir(checkerImplDir, { recursive: true });
  }

  const canonicalProjectDir = canonicalizeForComparison(await realpath(resolve(projectDir)));
  const canonicalCheckerImplDir = canonicalizeForComparison(await realpath(checkerImplDir));
  const relativePath = relative(canonicalProjectDir, canonicalCheckerImplDir);

  if (relativePath === "" || relativePath === "." || (!relativePath.startsWith("..") && !isAbsoluteLikePath(relativePath))) {
    return;
  }

  throw new Error(`Config checkerImplDir "${configPath}" must stay inside the project root after canonicalization.`);
}

function canonicalizeForComparison(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAbsoluteLikePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}
