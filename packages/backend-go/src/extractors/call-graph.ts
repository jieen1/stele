// Go CallGraph extractor for Stele Phase B evaluators (trace + effect).
//
// Spawns the bundled stdlib-only Go program (`go_call_graph_extractor.go`) via
// `go run`, feeds it a JSON request on stdin, and parses the JSON CallGraph
// response — exactly mirroring backend-python's `call-graph.ts`. The script uses
// only the Go standard library (go/parser, go/ast), so no third-party module is
// fetched; the only requirement on the target project is a Go toolchain on PATH
// (or `STELE_GO`).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  type CallGraph,
  type CallGraphExtractor,
  type ExtractOptions,
  assertValidCallGraph,
} from "@stele/call-graph-core";

const execFileAsync = promisify(execFile);

const _SCRIPT_BASENAME = "go_call_graph_extractor.go";
const _MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Locate the bundled Go extractor script. The package build copies the .go to
 * `dist/extractors/`; in dev (running from src/) it sits at
 * `src/extractors/`. We try both, mirroring backend-python.
 */
function locateExtractorScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "extractors", _SCRIPT_BASENAME),
    resolve(here, _SCRIPT_BASENAME),
    resolve(here, "..", "src", "extractors", _SCRIPT_BASENAME),
    resolve(here, "..", "..", "src", "extractors", _SCRIPT_BASENAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `[stele:go-callgraph] cannot find ${_SCRIPT_BASENAME} (looked at: ${candidates.join(", ")}). ` +
      "Reinstall @stele/backend-go.",
  );
}

async function resolveGoExecutable(): Promise<string> {
  const explicit = process.env.STELE_GO;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  try {
    await execFileAsync("go", ["version"], { maxBuffer: 4096, timeout: 10_000 });
    return "go";
  } catch {
    throw new Error(
      "[stele:go-callgraph] no Go toolchain found on PATH. Install Go or set STELE_GO to its absolute path.",
    );
  }
}

interface RequestBody {
  project_root: string;
  source_files?: readonly string[];
}

async function runScript(request: RequestBody): Promise<CallGraph> {
  const scriptPath = locateExtractorScript();
  const go = await resolveGoExecutable();
  // cwd = the script's own directory (no go.mod) so the project's go.mod /
  // toolchain directive can't redirect `go run`. GOTOOLCHAIN=local prevents an
  // auto-download attempt (the script is stdlib-only, no module needed).
  const child = execFile(go, ["run", scriptPath], {
    maxBuffer: _MAX_BUFFER,
    cwd: dirname(scriptPath),
    env: { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "" },
  });
  if (child.stdin === null) {
    throw new Error("[stele:go-callgraph] child stdin not available");
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
    throw new Error(`[stele:go-callgraph] extractor exited ${exitCode}: ${stderr.slice(0, 2000)}`);
  }
  const stdout = Buffer.concat(chunks).toString("utf8").trim();
  let graph: CallGraph;
  try {
    graph = JSON.parse(stdout) as CallGraph;
  } catch (e) {
    throw new Error(`[stele:go-callgraph] extractor returned non-JSON output: ${(e as Error).message}`);
  }
  // Fail loud if the extractor dropped a soundness-critical field (notably
  // `nameHidden` on unresolved calls).
  assertValidCallGraph(graph, "go extractor");
  return graph;
}

export const goCallGraphExtractor: CallGraphExtractor = {
  language: "go",

  async extract(options: ExtractOptions): Promise<CallGraph> {
    return runScript({ project_root: options.projectRoot, source_files: options.sourceFiles });
  },

  async extractIncremental(
    options: ExtractOptions & { changedFiles: readonly string[]; previous: CallGraph },
  ): Promise<CallGraph> {
    // MVP: re-extract the full graph on any change (matches backend-python).
    return runScript({ project_root: options.projectRoot, source_files: undefined });
  },
};
