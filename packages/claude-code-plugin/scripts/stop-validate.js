#!/usr/bin/env node
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const STOP_BLOCK_EXIT_CODE = 2;
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const steleCommandName = process.platform === "win32" ? "stele.cmd" : "stele";
const pythonCommandNames =
  process.platform === "win32" ? ["python.exe", "python.cmd", "python.bat"] : ["python"];

await main();

async function main() {
  const pathValue = process.env.PATH ?? "";
  const steleCommandPath = await resolveCommandOnPath([steleCommandName], pathValue);

  if (steleCommandPath === null) {
    blockStop(`Unable to run "${steleCommandName} check". Ensure the stele CLI is installed and on PATH.\n`);
    return;
  }

  const steleResult = await runCommand({
    stageName: "stele check",
    commandPath: steleCommandPath,
    args: ["check"],
    cwd: projectDir,
  });

  if (steleResult.code !== 0) {
    blockStop(`stele check failed with exit code ${steleResult.code}.\n`);
    return;
  }

  const pythonCommandPath = await resolveCommandOnPath(pythonCommandNames, pathValue);

  if (pythonCommandPath === null) {
    blockStop(
      'Unable to run "python -m pytest tests/contract -q". Ensure Python is installed, pytest is available, and both are on PATH.\n',
    );
    return;
  }

  const pytestResult = await runCommand({
    stageName: "pytest tests/contract",
    commandPath: pythonCommandPath,
    args: ["-m", "pytest", "tests/contract", "-q"],
    cwd: projectDir,
  });

  if (pytestResult.code !== 0) {
    if (isPytestUnavailable(pytestResult.stderr)) {
      blockStop(
        `python -m pytest tests/contract -q could not start the contract tests. Ensure Python is installed, pytest is available, and both are on PATH.\n`,
      );
      return;
    }

    blockStop(`pytest tests/contract failed with exit code ${pytestResult.code}.\n`);
    return;
  }

  process.exit(0);
}

function spawnCommand(commandPath, args, cwd) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd,
  };

  if (process.platform === "win32") {
    const command = [`"${commandPath}"`, ...args].join(" ");
    return spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  return spawn(commandPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runCommand({ stageName, commandPath, args, cwd }) {
  const child = spawnCommand(commandPath, args, cwd);
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(chunk);
  });

  return await new Promise((resolve, reject) => {
    let finished = false;

    child.on("error", (error) => {
      if (finished) {
        return;
      }

      finished = true;
      reject(new Error(`Unable to run ${stageName}: ${error instanceof Error ? error.message : String(error)}`));
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }

      finished = true;

      if (signal !== null) {
        reject(new Error(`${stageName} terminated with signal ${signal}.`));
        return;
      }

      resolve({ code: code ?? 1, stdout, stderr });
    });
  }).catch((error) => {
    blockStop(`${error instanceof Error ? error.message : String(error)}\n`);
  });
}

function isPytestUnavailable(stderr) {
  return /no module named pytest|modulenotfounderror:\s*no module named ['"]?pytest['"]?/iu.test(stderr);
}

async function resolveCommandOnPath(commands, pathValue) {
  for (const rawEntry of pathValue.split(path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");

    if (entry.length === 0) {
      continue;
    }

    for (const command of commands) {
      const candidate = path.resolve(entry, command);

      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

function blockStop(message) {
  process.stderr.write(message);
  process.exit(STOP_BLOCK_EXIT_CODE);
}
