#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const command = process.platform === "win32" ? "stele.cmd" : "stele";
const child = spawn(command, ["check"], {
  cwd: projectDir,
  env: {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  const message =
    error instanceof Error && "code" in error && error.code === "ENOENT"
      ? `Unable to run "${command} check". Ensure the stele CLI is installed and on PATH.\n`
      : `${error instanceof Error ? error.message : String(error)}\n`;

  process.stderr.write(message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`stele check terminated with signal ${signal}.\n`);
    process.exit(1);
    return;
  }

  process.exit(code ?? 1);
});
