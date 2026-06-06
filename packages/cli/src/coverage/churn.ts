import { execFile } from "node:child_process";
import { relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ChurnEntry {
  /** Number of non-merge commits that touched the file in the window. */
  readonly commits: number;
  /** Committer date (ISO) of the most recent touching commit, or undefined. */
  readonly lastTouched?: string;
}

/**
 * Injectable churn provider seam. Tests pass a stub so unit tests stay
 * git-free and deterministic. Production uses {@link gitChurn}.
 */
export type GetChurn = (
  projectDir: string,
  files: readonly string[],
  since: string | null,
) => Promise<Map<string, ChurnEntry>>;

function isOutsideProject(relativePath: string): boolean {
  return relativePath.startsWith("../") || relativePath === ".." || win32.isAbsolute(relativePath);
}

/**
 * Batched git churn. One `git log` call (not per-file), parsed into a
 * path → {commits, lastTouched} map. Fail-soft: if git is unavailable or the
 * repo is shallow, returns an empty map (coverage never depends on git).
 */
export const gitChurn: GetChurn = async (projectDir, files, since) => {
  const result = new Map<string, ChurnEntry>();
  const wanted = new Set(files);
  if (wanted.size === 0) return result;

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir });
    repoRoot = stdout.trim();
  } catch {
    return result;
  }

  const range = since ? [`${since}..HEAD`] : [];
  let stdout: string;
  try {
    const out = await execFileAsync(
      "git",
      ["log", ...range, "--no-merges", "--name-only", "--date=iso-strict", "--format=commit\t%cd"],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
    stdout = out.stdout;
  } catch {
    return result;
  }

  const projectRoot = resolve(projectDir);
  let currentDate: string | undefined;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("commit\t")) {
      currentDate = line.slice("commit\t".length);
      continue;
    }
    if (line.length === 0) continue;
    const absolutePath = resolve(repoRoot, line);
    const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");
    if (relativePath.length === 0 || isOutsideProject(relativePath)) continue;
    if (!wanted.has(relativePath)) continue;
    const existing = result.get(relativePath);
    if (existing === undefined) {
      // First (most recent, git log is reverse-chronological) touch wins lastTouched.
      result.set(relativePath, { commits: 1, lastTouched: currentDate });
    } else {
      result.set(relativePath, { commits: existing.commits + 1, lastTouched: existing.lastTouched });
    }
  }

  return result;
};
