#!/usr/bin/env node
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { extractTargetPaths } from "./path-utils.js";
const steleLocalCommandNames = process.platform === "win32" ? ["stele.cmd", "stele.bat"] : ["stele"];
const stelePathCommandNames = process.platform === "win32" ? ["stele.cmd", "stele.bat"] : ["stele"];

try {
  const stdin = await readStdin();
  const payload = parseHookInput(stdin);
  const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

  if (!(await hasSteleConfig(projectDir))) {
    process.exit(0);
  }

  const steleCommandPath = await resolveSteleCommand(projectDir, process.env.PATH ?? "");

  if (steleCommandPath === null) {
    process.exit(0);
  }

  const args = ["agent-context"];
  const focusPaths = await getFocusPaths(projectDir, payload);

  for (const focusPath of focusPaths) {
    args.push("--focus", focusPath);
  }

  const result = await runCommand({
    commandPath: steleCommandPath,
    args,
    cwd: projectDir,
  });

  const additionalContext = normalizeLineEndings(result.stdout);

  if (result.code !== 0 || additionalContext.trim().length === 0) {
    process.exit(0);
  }

  process.stdout.write(
    `${JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: getHookEventName(payload),
        additionalContext,
      },
    })}\n`,
  );
} catch {
  process.exit(0);
}

async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }

  return chunks.join("");
}

function parseHookInput(stdin) {
  if (stdin.trim().length === 0) {
    return {};
  }

  return JSON.parse(stdin);
}

async function hasSteleConfig(projectDir) {
  try {
    await access(path.join(projectDir, "stele.config.json"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function getFocusPaths(projectDir, payload) {
  const hookEventName = getHookEventName(payload);

  if (hookEventName === "PreToolUse") {
    return extractTargetPaths(payload);
  }

  if (hookEventName === "UserPromptSubmit") {
    return await collectGitDiffFiles(projectDir);
  }

  return [];
}

function getHookEventName(payload) {
  if (isObject(payload) && typeof payload.hook_event_name === "string") {
    return payload.hook_event_name;
  }

  if (isObject(payload) && typeof payload.hookEventName === "string") {
    return payload.hookEventName;
  }

  return "SessionStart";
}

// extractTargetPaths and extractPathsFromValue imported from path-utils.js
async function collectGitDiffFiles(projectDir) {
  const result = await runCommand({
    commandPath: "git",
    args: ["diff", "--name-only"],
    cwd: projectDir,
  });

  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function resolveSteleCommand(cwd, pathValue) {
  const localCommandPath = await resolveCommandAtLocations(
    [path.join(cwd, "node_modules", ".bin")],
    steleLocalCommandNames,
  );

  if (localCommandPath !== null) {
    return localCommandPath;
  }

  return await resolveCommandOnPath(stelePathCommandNames, pathValue);
}

async function resolveCommandAtLocations(searchDirs, commands) {
  for (const searchDir of searchDirs) {
    for (const command of commands) {
      const candidate = path.join(searchDir, command);

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

function spawnCommand(commandPath, args, cwd) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd,
  };

  // Use shell: false on all platforms. On Windows, spawn with shell: false
  // correctly resolves the executable via PATHEXT, avoiding cmd.exe metacharacter
  // injection vectors (%VAR%, !, ^, backtick, etc.) present in the old
  // shell: true + quoteWindowsShellArg() pattern (CVE-style command injection).
  return spawn(commandPath, args, {
    cwd,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runCommand({ commandPath, args, cwd }) {
  const child = spawnCommand(commandPath, args, cwd);
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return await new Promise((resolve) => {
    let finished = false;

    child.on("error", (error) => {
      if (finished) {
        return;
      }

      finished = true;
      resolve({ code: 1, stdout, stderr: `${stderr}${error instanceof Error ? error.message : String(error)}` });
    });

    child.on("close", (code) => {
      if (finished) {
        return;
      }

      finished = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function normalizeLineEndings(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}
