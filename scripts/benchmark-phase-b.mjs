#!/usr/bin/env node
// Phase B performance benchmark — runs `stele check` against a target project
// and records wall-clock + memory peak. Outputs a JSON report.
//
// Budget targets (FINAL-SPEC §D-B-007):
//   - Medium project (~1000 files):  < 60s
//   - Large project  (~10000 files): < 5 min
//   - Incremental:                   < 20s

import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, stat } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const CLI_ENTRY = resolve(REPO_ROOT, "packages/cli/dist/index.js");

function usage() {
  console.error(
    [
      "Usage: node scripts/benchmark-phase-b.mjs <project-dir> [output.json]",
      "",
      "Runs `stele check` twice (cold + warm) against the target project and",
      "writes a JSON report to <output.json> (defaults to stdout only).",
      "",
      "Budget (FINAL-SPEC §D-B-007):",
      "  medium (~1000 files)  < 60s",
      "  large  (~10000 files) < 5 min",
      "  incremental           < 20s",
    ].join("\n"),
  );
}

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h") {
  usage();
  process.exit(arg ? 0 : 2);
}

const projectDir = resolve(arg);
const outputJson = process.argv[3] ? resolve(process.argv[3]) : null;

try {
  const s = await stat(projectDir);
  if (!s.isDirectory()) {
    console.error(`error: project-dir is not a directory: ${projectDir}`);
    process.exit(2);
  }
} catch (err) {
  console.error(`error: cannot stat project-dir ${projectDir}: ${err.message}`);
  process.exit(2);
}

try {
  await stat(CLI_ENTRY);
} catch {
  console.error(
    `error: CLI build not found at ${CLI_ENTRY}\n` +
      `       run \`pnpm build\` from ${REPO_ROOT} first.`,
  );
  process.exit(2);
}

function countFiles(dir, skip = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__"])) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) n++;
    }
  }
  return n;
}

async function measure(label, command, args) {
  const start = process.hrtime.bigint();
  const child = spawn(command, args, {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stdout = "";
  let stderr = "";
  let peakRssBytes = 0;
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // Sample RSS while the child runs (best-effort on Linux via /proc).
  const sampleInterval = setInterval(() => {
    try {
      const statusPath = `/proc/${child.pid}/status`;
      // synchronous read is fine here — pid may already be gone.
      const buf = require("node:fs").readFileSync(statusPath, "utf8");
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(buf);
      if (m) {
        const bytes = Number(m[1]) * 1024;
        if (bytes > peakRssBytes) peakRssBytes = bytes;
      }
    } catch {
      // pid gone or non-Linux — give up silently
    }
  }, 50);

  const exitCode = await new Promise((res) => {
    child.on("exit", (code) => res(code));
  });
  clearInterval(sampleInterval);

  const elapsedMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
  return {
    label,
    exitCode,
    elapsedMs,
    peakRssBytes,
    peakRssMb: peakRssBytes ? Math.round((peakRssBytes / (1024 * 1024)) * 10) / 10 : null,
    stdout: stdout.slice(-2000),
    stderr: stderr.slice(-2000),
  };
}

// Lazy `require` for the optional /proc sampling above.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const fileCount = countFiles(projectDir);

const results = {
  schema_version: "1",
  measured_at: new Date().toISOString(),
  project_dir: projectDir,
  cli_entry: CLI_ENTRY,
  node_version: process.version,
  platform: `${process.platform} ${process.arch}`,
  approx_file_count: fileCount,
  budget: {
    medium_ms: 60_000,
    large_ms: 300_000,
    incremental_ms: 20_000,
  },
  runs: [],
};

// Cold run (process startup + first parse).
results.runs.push(await measure("cold", "node", [CLI_ENTRY, "check"]));
// Warm run (caches in OS page cache; the engine itself has no in-memory cache yet).
results.runs.push(await measure("warm", "node", [CLI_ENTRY, "check"]));

console.log(JSON.stringify(results, null, 2));
if (outputJson) {
  await writeFile(outputJson, JSON.stringify(results, null, 2) + "\n");
  console.error(`wrote ${outputJson}`);
}
