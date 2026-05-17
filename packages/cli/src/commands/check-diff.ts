import { execFile } from "node:child_process";
import { relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type { Contract, ContractFile } from "@stele/core";

const execFileAsync = promisify(execFile);

function isOutsideProject(relativePath: string): boolean {
  return relativePath.startsWith("../") || relativePath === ".." || win32.isAbsolute(relativePath);
}

async function runGit(cwd: string, args: string[], errorMessage: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${errorMessage} ${detail}`.trim());
  }
}

/**
 * Collect the relative paths of changed `.stele` contract files since the given
 * git ref.  Falls back to an empty list when git is unavailable.
 */
export async function collectDiffContractFiles(projectDir: string, ref: string): Promise<string[]> {
  try {
    const repoRoot = await runGit(projectDir, ["rev-parse", "--show-toplevel"], "Unable to find git repository root.");
    const output = await runGit(
      repoRoot,
      ["diff", "--name-only", `${ref}...HEAD`, "--", "contract/"],
      "Unable to compute diff.",
    );

    const projectRoot = resolve(projectDir);
    const changedFiles = new Set<string>();

    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate || !candidate.endsWith(".stele")) continue;

      const absolutePath = resolve(repoRoot, candidate);
      const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");

      if (relativePath.length > 0 && !isOutsideProject(relativePath)) {
        changedFiles.add(relativePath);
      }
    }

    return [...changedFiles].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Collect all changed/added/staged/unstaged/untracked paths relative to the
 * project directory, for diff-scoping a check run.
 */
export async function collectGitDiffScope(projectDir: string, baseRef: string): Promise<string[]> {
  const repoRoot = await runGit(
    projectDir,
    ["rev-parse", "--show-toplevel"],
    `Git is required for --diff-from ${baseRef}, but no repository root was found.`,
  );
  await runGit(
    repoRoot,
    ["rev-parse", "--verify", `${baseRef}^{commit}`],
    `Git base "${baseRef}" was not found. Choose an existing branch, tag, or commit for --diff-from.`,
  );

  const outputs = await Promise.all([
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${baseRef}...HEAD`], "Unable to compute the branch diff."),
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB"], "Unable to compute unstaged diff scope."),
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", "--cached"], "Unable to compute staged diff scope."),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], "Unable to list untracked files for diff scope."),
  ]);
  const projectRoot = resolve(projectDir);
  const diffPaths = new Set<string>();

  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim();

      if (candidate.length === 0) {
        continue;
      }

      const absolutePath = resolve(repoRoot, candidate);
      const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");

      if (relativePath.length === 0 || isOutsideProject(relativePath)) {
        continue;
      }

      diffPaths.add(relativePath);
    }
  }

  return [...diffPaths].sort((left, right) => left.localeCompare(right));
}

/**
 * Return a new Contract object whose invariants are limited to those whose
 * filePath appears in `changedFileSet`.  Non-invariant declarations are
 * preserved so downstream generators still see the full contract shape.
 */
export function filterContractByFiles(contract: Contract, changedFileSet: Set<string>): Contract {
  const filteredFiles = contract.files.map((file) => {
    if (!changedFileSet.has(file.path)) {
      return {
        ...file,
        invariants: [],
        groups: file.groups.map((g) => ({ ...g, invariants: [] })),
        codeShapes: [],
      } as ContractFile;
    }
    return file;
  });

  return {
    ...contract,
    files: filteredFiles,
    invariants: contract.invariants.filter((inv) => changedFileSet.has(inv.filePath)),
    codeShapes: contract.codeShapes.filter((cs) => changedFileSet.has(cs.filePath)),
  };
}
