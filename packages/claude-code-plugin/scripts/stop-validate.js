#!/usr/bin/env node
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const STOP_BLOCK_EXIT_CODE = 2;
const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const commandName = process.platform === "win32" ? "stele.cmd" : "stele";

await main();

async function main() {
  const commandPath = await resolveCommandOnPath(commandName, process.env.PATH ?? "");

  if (commandPath === null) {
    blockStop(`Unable to run "${commandName} check". Ensure the stele CLI is installed and on PATH.\n`);
    return;
  }

  const child = spawnSteleCheck(commandPath, projectDir);
  let finished = false;

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  child.on("error", (error) => {
    if (finished) {
      return;
    }

    finished = true;
    blockStop(`${error instanceof Error ? error.message : String(error)}\n`);
  });

  child.on("close", (code, signal) => {
    if (finished) {
      return;
    }

    finished = true;

    if (signal !== null) {
      blockStop(`stele check terminated with signal ${signal}.\n`);
      return;
    }

    if (code === 0) {
      process.exit(0);
      return;
    }

    blockStop(`stele check failed with exit code ${code ?? 1}.\n`);
  });
}

function spawnSteleCheck(commandPath, cwd) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd,
  };

  if (process.platform === "win32") {
    return spawn(`"${commandPath}" check`, {
      cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  return spawn(commandPath, ["check"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function resolveCommandOnPath(command, pathValue) {
  for (const rawEntry of pathValue.split(path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/u, "$1");

    if (entry.length === 0) {
      continue;
    }

    const candidate = path.resolve(entry, command);

    try {
      await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function blockStop(message) {
  process.stderr.write(message);
  process.exit(STOP_BLOCK_EXIT_CODE);
}
