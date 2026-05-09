import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliRunnerOptions {
  cwd?: string;
  /** Override the spawn function (used in tests). Returns the same shape as `spawnSync`. */
  spawn?: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => { status: number | null; stdout: string; stderr: string };
}

/**
 * Run `npx stele <args>` and capture stdout / stderr / exit code.
 *
 * On the first call we probe `npx stele --version` so we can fail with a clear
 * "install @stele/cli first" message instead of letting the action exit with a
 * cryptic spawn error.
 */
export async function spawnCli(args: string[], options: CliRunnerOptions = {}): Promise<CliResult> {
  const spawn = options.spawn ?? defaultSpawn;
  const cwd = options.cwd ?? process.cwd();

  const versionCheck = spawn("npx", ["stele", "--version"], {
    encoding: "utf-8",
    cwd,
  });
  if (versionCheck.status !== 0) {
    throw new Error(
      "Stele CLI not found. Run `npm install --save-dev @stele/cli` (or pnpm/yarn equivalent) in your repo before invoking this Action.",
    );
  }

  const result = spawn("npx", ["stele", ...args], {
    encoding: "utf-8",
    cwd,
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function defaultSpawn(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}
