import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getGitInfo(
  projectDir: string,
): Promise<{ commit: string | undefined; branch: string | undefined }> {
  const result: { commit: string | undefined; branch: string | undefined } = {
    commit: undefined,
    branch: undefined,
  };

  try {
    const { stdout: commit } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
    });
    result.commit = commit.trim();
  } catch {
    // Not a git repo or HEAD does not exist yet
  }

  try {
    const { stdout: branch } = await execFileAsync("git", [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ], {
      cwd: projectDir,
    });
    result.branch = branch.trim();
  } catch {
    // Branch query can fail (e.g., detached HEAD)
  }

  return result;
}
