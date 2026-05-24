// Round 14 P0: Python CallGraph extractor for Phase B evaluators.
//
// Spawns the bundled Python script (`python_call_graph_extractor.py`)
// as a subprocess, feeds it a JSON request on stdin, and parses the
// JSON CallGraph response. The script uses Python's built-in `ast`
// module so no third-party dependency is needed in the target
// project's Python environment beyond `python3` itself.
//
// Trace / type-state / effect evaluators consume the returned graph
// exactly the same way as the TypeScript extractor's output — the
// `CallGraph` shape from `@stele/call-graph-core` is the contract.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  CallGraph,
  CallGraphExtractor,
  ExtractOptions,
} from "@stele/call-graph-core";

const execFileAsync = promisify(execFile);

const _SCRIPT_BASENAME = "python_call_graph_extractor.py";
const _MAX_BUFFER = 64 * 1024 * 1024; // 64 MB graph JSON cap

/**
 * Locate the bundled Python extractor script. tsup bundles all TS
 * into `dist/index.js`, then the package build script copies the .py
 * to `dist/extractors/python_call_graph_extractor.py`. In dev mode
 * (running from src/), the script is at
 * `src/extractors/python_call_graph_extractor.py`. We try both.
 */
function locateExtractorScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Bundled: .../backend-python/dist/extractors/<script>
    resolve(here, "extractors", _SCRIPT_BASENAME),
    // Co-located: .../backend-python/dist/<script> (some build layouts)
    resolve(here, _SCRIPT_BASENAME),
    // Dev / source-tree: .../backend-python/src/extractors/<script>
    resolve(here, "..", "src", "extractors", _SCRIPT_BASENAME),
    resolve(here, "..", "..", "src", "extractors", _SCRIPT_BASENAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `[stele:py-callgraph] cannot find ${_SCRIPT_BASENAME} (looked at: ${candidates.join(", ")}). ` +
      "Reinstall @stele/backend-python.",
  );
}

async function resolvePythonExecutable(): Promise<string> {
  // Honour explicit override first (matches code-shape evaluator
  // convention so users only have to set one env var).
  const explicit = process.env.STELE_PYTHON;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  // Try the canonical candidates in order. `python3` is the Python 3
  // canonical name; `python` is the Windows / Conda default; `py -3`
  // is the Windows launcher form.
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: "python3", args: [] },
    { cmd: "python", args: [] },
    { cmd: "py", args: ["-3"] },
  ];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.cmd, [...candidate.args, "--version"], {
        maxBuffer: 1024,
        timeout: 5_000,
      });
      return candidate.cmd === "py" ? "py -3" : candidate.cmd;
    } catch {
      continue;
    }
  }
  throw new Error(
    "[stele:py-callgraph] no Python 3 interpreter found on PATH. " +
      "Install Python 3 or set STELE_PYTHON to its absolute path.",
  );
}

interface RequestBody {
  project_root: string;
  source_files?: readonly string[];
}

async function runScript(request: RequestBody): Promise<CallGraph> {
  const scriptPath = locateExtractorScript();
  const py = await resolvePythonExecutable();
  const [cmd, ...pyArgs] = py.split(/\s+/u);
  const args = [...pyArgs, scriptPath];
  const child = execFile(cmd!, args, { maxBuffer: _MAX_BUFFER });
  if (child.stdin === null) {
    throw new Error("[stele:py-callgraph] child stdin not available");
  }
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();

  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  }
  const exitCode: number = await new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code) => resolveExit(code ?? 0));
  });
  if (exitCode !== 0) {
    const stderr = Buffer.concat(errChunks).toString("utf8");
    throw new Error(
      `[stele:py-callgraph] extractor exited ${exitCode}: ${stderr.slice(0, 2000)}`,
    );
  }
  const stdout = Buffer.concat(chunks).toString("utf8").trim();
  try {
    return JSON.parse(stdout) as CallGraph;
  } catch (e) {
    throw new Error(
      `[stele:py-callgraph] extractor returned non-JSON output: ${(e as Error).message}`,
    );
  }
}

export const pyCallGraphExtractor: CallGraphExtractor = {
  language: "python",

  async extract(options: ExtractOptions): Promise<CallGraph> {
    return runScript({
      project_root: options.projectRoot,
      source_files: options.sourceFiles,
    });
  },

  async extractIncremental(
    options: ExtractOptions & { changedFiles: readonly string[]; previous: CallGraph },
  ): Promise<CallGraph> {
    // MVP incremental strategy: when any file changed, re-extract the
    // FULL graph. Python's project sizes are typically small enough
    // that re-parse cost is tolerable; the spec allows this. A future
    // pass can adopt the same per-file caching `tsCallGraphExtractor`
    // implements.
    return runScript({
      project_root: options.projectRoot,
      source_files: undefined,
    });
  },
};
