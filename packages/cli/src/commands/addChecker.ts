import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { isMissingFileError } from "../utils/shared-utils.js";

const CHECKER_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
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
      `Invalid checker id "${checkerId}". Checker ids must match ${CHECKER_ID_PATTERN} so they stay valid CDL identifiers.`,
    );
  }

  const config = await loadConfig(projectDir);
  const checkerImplDir = resolve(projectDir, config.checkerImplDir);
  await ensureSafeCheckerImplDirectory(projectDir, checkerImplDir, config.checkerImplDir);
  const checkerModuleName = toPythonCheckerModuleName(checkerId);
  const checkerPath = resolve(checkerImplDir, `${checkerModuleName}.py`);

  await mkdir(dirname(checkerPath), { recursive: true });
  await assertNoCheckerModuleCollision(checkerImplDir, checkerId, checkerModuleName);

  try {
    await writeFile(checkerPath, CHECKER_STUB, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(
        `Checker implementation for "${checkerId}" already exists at ${checkerPath}. Another checker id may already map to the same Python filename.`,
      );
    }

    throw error;
  }

  process.stdout.write(`(checker ${checkerId}\n  (description "TODO: describe what this checker validates."))\n`);
}

function toPythonCheckerModuleName(checkerId: string): string {
  return checkerId.replaceAll("-", "_");
}

async function assertNoCheckerModuleCollision(checkerImplDir: string, checkerId: string, checkerModuleName: string): Promise<void> {
  const requestedModuleKey = toCheckerModuleKey(checkerModuleName);
  const directoryEntries = await readdir(checkerImplDir, { withFileTypes: true });

  for (const entry of directoryEntries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".py")) {
      continue;
    }

    const existingModuleName = entry.name.slice(0, -3);

    if (toCheckerModuleKey(existingModuleName) === requestedModuleKey) {
      throw new Error(
        `Checker implementation for "${checkerId}" would collide with existing Python module "${entry.name}" in ${checkerImplDir}.`,
      );
    }
  }
}

function toCheckerModuleKey(moduleName: string): string {
  return moduleName.replaceAll("-", "_").toLowerCase();
}

async function ensureSafeCheckerImplDirectory(projectDir: string, checkerImplDir: string, configPath: string): Promise<void> {
  const existingAncestors = buildAncestorChain(projectDir, checkerImplDir);
  let checkerImplDirExists = true;

  for (const ancestorPath of existingAncestors) {
    try {
      const stats = await lstat(ancestorPath);

      if (stats.isSymbolicLink()) {
        throw new Error(`Config checkerImplDir "${configPath}" must not contain symlink or junction ancestors.`);
      }

      if (!stats.isDirectory()) {
        throw new Error(`Config checkerImplDir "${configPath}" must resolve through regular directories inside the project root.`);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      checkerImplDirExists = false;
      break;
    }
  }

  if (!checkerImplDirExists) {
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

function isAbsoluteLikePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

function buildAncestorChain(projectDir: string, checkerImplDir: string): string[] {
  const relativePath = relative(resolve(projectDir), checkerImplDir);
  const segments = relativePath.split(/[/\\]+/).filter((segment) => segment.length > 0);
  const ancestors: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    ancestors.push(resolve(projectDir, ...segments.slice(0, index + 1)));
  }

  return ancestors;
}
