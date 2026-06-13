import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { commandName } from "@stele/core";
import type { Command } from "commander";

import { ExitCode } from "../../errors.js";
import {
  type IncidentDraft,
  fixCommitterDate,
  incidentScratchDir,
  proofsScratchDir,
  readDraftJson,
} from "./shared.js";
import {
  type BiteClass,
  type ResolvedToolchain,
  type TeethRunner,
  assertSafeTestBasename,
  resolveTeethRunner,
} from "./teeth-runners.js";

/**
 * The teeth verdict union is shared with `approve`: teeth itself only ever
 * produces TEETH_PROVEN | TEETH_FAILED (both derived purely from exit codes).
 * TEETH_UNAVAILABLE is NEVER written here — `approve` records it via a typed
 * --teeth-unavailable-reason when no proof exists. The union lives in one place
 * so approve can reuse it.
 */
export type TeethVerdict = "TEETH_PROVEN" | "TEETH_FAILED" | "TEETH_UNAVAILABLE";

/**
 * A single pytest run inside an isolated worktree. `outputSha256` is the hex
 * sha256 of (stdout ++ stderr) bytes concatenated. NOTE: pytest output contains
 * non-deterministic fragments (durations, tmp paths, session timing), so this
 * hash is EVIDENCE-FOR-HUMANS, not a determinism contract — and that is fine
 * because teeth.json is SCRATCH (never hashed by the manifest; C2
 * SCRATCH_NEVER_HASHED). The load-bearing field is `exit`, which alone decides
 * the verdict.
 */
export type RunResult = { exit: number; outputSha256: string };

/**
 * The on-disk `.stele/proofs/<id>/teeth.json` shape. `producedAtFromGit` is the
 * fix commit's committer date (ISO-8601 from `git show -s --format=%cI`), never
 * a wall-clock read, so the file is reproducible. `testSha256` binds the proof
 * to the exact candidate-test bytes; `invariantSha256` binds it to the exact
 * invariant CDL text — so approve can refuse a draft that proved teeth on one
 * invariant then swapped in a weaker one (the proof attests to BOTH the test
 * AND the invariant it was produced for).
 */
export type TeethProof = {
  verdict: TeethVerdict;
  parentSha: string;
  fixSha: string;
  testSha256: string;
  invariantSha256: string;
  /**
   * How the PARENT run failed (B2 bite-strength). TEETH_PROVEN requires this to
   * NOT be `collection-or-build` — a parent that failed to import/compile never
   * ran its assertions, so it does not prove the test catches the regression.
   */
  parentBiteClass: BiteClass;
  parentRun: RunResult;
  fixRun: RunResult;
  producedAtFromGit: string;
};

export type IncidentTeethOptions = { id: string };

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function git(projectDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function addWorktree(projectDir: string, dir: string, sha: string): void {
  // --detach: check out the historical SHA without creating/moving a branch.
  // --force: the dir is fresh under tmp, but be explicit.
  git(projectDir, ["worktree", "add", "--detach", "--force", dir, sha]);
}

function removeWorktree(projectDir: string, dir: string): void {
  try {
    git(projectDir, ["worktree", "remove", "--force", dir]);
  } catch {
    // The worktree may be half-created or already gone; fall through to the
    // filesystem rm + prune so we never strand a worktree.
  }
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // best-effort
  }
}

/**
 * Run the candidate test at one revision inside its isolated worktree. The test
 * is written (per the runner's placement) to a NON-tracked path under the
 * worktree, then the runner's command runs with cwd = worktree root so the test
 * resolves against that revision's source. "Fails" means non-zero exit — that
 * includes both an assertion failure AND a collection/import/compile error (e.g.
 * the test references a symbol that only exists at <fix>); both are legitimate
 * "the bug was reproducible at the parent" signals. The verdict is derived from
 * the exit code ONLY, so this stays language-agnostic.
 */
function runTestInWorktree(
  runner: TeethRunner,
  toolchain: ResolvedToolchain,
  worktreeDir: string,
  testBasename: string,
  testBytes: Buffer,
): RunResult & { normalizedOutput: string } {
  const placedRel = runner.placement(testBasename);
  const placedAbs = join(worktreeDir, placedRel);
  mkdirSync(dirname(placedAbs), { recursive: true });
  writeFileSync(placedAbs, testBytes);

  const { cmd, args, env } = runner.buildRun(toolchain, placedRel, worktreeDir);

  let exit: number;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(cmd, [...args], {
      cwd: worktreeDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    exit = 0;
  } catch (error) {
    const err = error as {
      status?: number | null;
      code?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (err.code === "ENOENT") {
      // The toolchain binary itself is missing — INFRA error, not a verdict.
      throw new Error(
        `${runner.language} toolchain ${JSON.stringify(cmd)} not found; cannot run teeth.`,
      );
    }
    if (typeof err.status === "number") {
      exit = err.status;
    } else {
      // Killed by signal / no numeric status — treat as infra failure.
      throw new Error(
        `${runner.language} test runner did not exit with a numeric status (signal?); cannot determine verdict.`,
      );
    }
    stdout = err.stdout ? err.stdout.toString() : "";
    stderr = err.stderr ? err.stderr.toString() : "";
  }

  const combined = normalizeTeethOutput(`${stdout}${stderr}`, worktreeDir);
  return {
    exit,
    outputSha256: sha256Hex(Buffer.from(combined, "utf8")),
    normalizedOutput: combined,
  };
}

export type WorktreeRun = RunResult & { normalizedOutput: string };

/**
 * Create two isolated detached worktrees (parentSha, fixSha) under os.tmpdir(),
 * place + run the candidate test in each via the runner, and ALWAYS remove +
 * prune both worktrees in a finally. Shared by `teeth` (produce the proof) and
 * `reverify` (re-derive the verdict from git). Throws on any infra failure
 * (missing rev, worktree-add failure, absent toolchain) — callers map that to
 * exit 1, never a verdict.
 */
export function runCandidateInWorktrees(
  projectDir: string,
  opts: {
    tmpLabel: string;
    parentSha: string;
    fixSha: string;
    testBasename: string;
    testBytes: Buffer;
    runner: TeethRunner;
    toolchain: ResolvedToolchain;
  },
): { parentRun: WorktreeRun; fixRun: WorktreeRun } {
  const sha8 = (s: string): string => s.slice(0, 8);
  const base = mkdtempSync(join(tmpdir(), `stele-incident-${opts.tmpLabel}-`));
  const parentDir = join(base, `parent-${sha8(opts.parentSha)}`);
  const fixDir = join(base, `fix-${sha8(opts.fixSha)}`);

  let parentAdded = false;
  let fixAdded = false;
  try {
    // Prune stale registrations from a prior crash before adding (git refuses a
    // path whose registration lingers); the finally prunes again after removal.
    try {
      git(projectDir, ["worktree", "prune"]);
    } catch {
      // best-effort
    }
    addWorktree(projectDir, parentDir, opts.parentSha);
    parentAdded = true;
    addWorktree(projectDir, fixDir, opts.fixSha);
    fixAdded = true;

    const parentRun = runTestInWorktree(opts.runner, opts.toolchain, parentDir, opts.testBasename, opts.testBytes);
    const fixRun = runTestInWorktree(opts.runner, opts.toolchain, fixDir, opts.testBasename, opts.testBytes);
    return { parentRun, fixRun };
  } finally {
    if (parentAdded) {
      removeWorktree(projectDir, parentDir);
    }
    if (fixAdded) {
      removeWorktree(projectDir, fixDir);
    }
    try {
      git(projectDir, ["worktree", "prune"]);
    } catch {
      // best-effort
    }
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // best-effort — the ephemeral base dir.
    }
  }
}

/**
 * Derive the verdict + parent bite-class from the two runs. TEETH_PROVEN iff the
 * parent FAILS, the fix PASSES, and the parent failure was not a collection/
 * build error (which means the test never ran its assertions at <fix>^).
 * `unknown` bite-class conservatively falls back to the exit-code rule.
 */
export function deriveTeethVerdict(
  parentRun: WorktreeRun,
  fixRun: WorktreeRun,
  runner: TeethRunner,
): { verdict: TeethVerdict; parentBiteClass: BiteClass } {
  const parentBiteClass: BiteClass =
    parentRun.exit === 0 ? "passed" : runner.classifyFailure(parentRun.normalizedOutput);
  const exitsProve = parentRun.exit !== 0 && fixRun.exit === 0;
  const verdict: TeethVerdict =
    exitsProve && parentBiteClass !== "collection-or-build" ? "TEETH_PROVEN" : "TEETH_FAILED";
  return { verdict, parentBiteClass };
}

/**
 * Make the pytest output byte-reproducible BEFORE hashing it, so two runs of the
 * same test in different throwaway worktrees yield an identical outputSha256 and
 * a byte-identical teeth.json (F2). pytest emits run-varying fragments: per-test
 * and session DURATIONS ("... in 0.12s", "1.30s setup"), the ABSOLUTE worktree
 * path (a fresh mkdtemp dir every run), and OBJECT MEMORY ADDRESSES in default
 * reprs ("<function exists at 0x7fdc229dbe20>") which pytest's assertion-rewrite
 * introspection prints whenever a failing assert references an object without a
 * stable __repr__. We canonicalize all of them. The verdict never depends on this
 * text — it is derived from the exit code — but a stable hash turns teeth.json
 * into a reproducible artifact.
 */
export function normalizeTeethOutput(raw: string, worktreeDir: string): string {
  const escaped = worktreeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw
    .replace(/\r\n/g, "\n")
    .replace(new RegExp(escaped, "g"), "<worktree>")
    // node:test TAP footer "# duration_ms 30.716676" -> "# duration_ms <duration>"
    .replace(/# duration_ms\s+\d+(?:\.\d+)?/g, "# duration_ms <duration>")
    // node:test per-subtest YAML "  duration_ms: 0.318376" (no '#', no 's' suffix)
    .replace(/duration_ms:\s+\d+(?:\.\d+)?/g, "duration_ms: <duration>")
    // "1 passed in 0.12s", "in 0.12s", "in 1.3s ===" -> "in <duration>"
    .replace(/\bin\s+\d+(?:\.\d+)?s\b/g, "in <duration>")
    // any remaining bare "0.12s" timing token (durations report rows)
    .replace(/\b\d+(?:\.\d+)?s\b/g, "<duration>")
    // hex memory addresses in default object reprs ("at 0x7fdc229dbe20") — the
    // process heap location varies every run and would otherwise leak into the
    // hash for any failing assert that prints an object repr.
    .replace(/0x[0-9a-fA-F]+/g, "<addr>");
}

function serializeTeeth(proof: TeethProof): string {
  // Fixed key order — byte-stable.
  const ordered = {
    verdict: proof.verdict,
    parentSha: proof.parentSha,
    fixSha: proof.fixSha,
    testSha256: proof.testSha256,
    invariantSha256: proof.invariantSha256,
    parentBiteClass: proof.parentBiteClass,
    parentRun: { exit: proof.parentRun.exit, outputSha256: proof.parentRun.outputSha256 },
    fixRun: { exit: proof.fixRun.exit, outputSha256: proof.fixRun.outputSha256 },
    producedAtFromGit: proof.producedAtFromGit,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function writeTeethProof(projectDir: string, id: string, proof: TeethProof): string {
  const dir = proofsScratchDir(projectDir, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "teeth.json");
  writeFileSync(path, serializeTeeth(proof), "utf8");
  return path;
}

function fail(message: string): void {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = ExitCode.USER_ERROR;
}

/**
 * Read draft.json → resolve the candidate-test bytes from incident scratch →
 * create two ISOLATED detached worktrees (parentSha, fixSha) under os.tmpdir() →
 * run the candidate test in each with the repo python → derive the verdict from
 * exit codes ONLY (TEETH_PROVEN iff parent FAILS && fix PASSES) → write
 * .stele/proofs/<id>/teeth.json → ALWAYS remove + prune both worktrees in a
 * finally.
 *
 * Exit semantics: process.exitCode 0 if teeth RAN (PROVEN or FAILED), 1 on any
 * INFRA error (missing draft, unresolvable rev, absent python, worktree failure,
 * unsafe testFilename). An infra error never silently degrades to a verdict.
 *
 * Never touches the main working tree, never writes a .stele/*.stele file, never
 * runs the repo's own negative-test suite — only the single candidate test,
 * foreground + serial, inside throwaway worktrees.
 */
export async function runIncidentTeeth(
  projectDir: string,
  options: IncidentTeethOptions,
  deps: { stdout?: NodeJS.WritableStream; python?: string } = {},
): Promise<void> {
  const out = deps.stdout ?? process.stdout;
  const id = options.id;

  let draft: IncidentDraft;
  let parentSha: string;
  let fixSha: string;
  let producedAtFromGit: string;
  let testBasename: string;
  let testBytes: Buffer;
  try {
    draft = await readDraftJson(projectDir, id);
    parentSha = draft.parentSha;
    fixSha = draft.fixSha;

    testBasename = assertSafeTestBasename(draft.testFilename);
    const incidentDir = incidentScratchDir(projectDir, id);
    const candidateTestPath = join(incidentDir, testBasename);

    // Reject a symlinked candidate test before reading its bytes.
    const st = lstatSync(candidateTestPath);
    if (st.isSymbolicLink()) {
      throw new Error(
        `Candidate test ${candidateTestPath} is a symlink; refusing to copy.`,
      );
    }
    testBytes = readFileSync(candidateTestPath);

    // Reproducible timestamp — fix commit's committer date, never wall-clock.
    producedAtFromGit = await fixCommitterDate(projectDir, fixSha);
  } catch (error) {
    fail((error as Error).message);
    return;
  }

  const testSha256 = sha256Hex(testBytes);
  // Bind the proof to the EXACT invariant text too (raw bytes — byte-stable
  // because draft.invariantCdl is persisted once and read identically here and
  // at approve). Closes the "prove teeth on a strict invariant, then swap in a
  // vacuous one" hole; approve re-checks this against the current draft.
  const invariantSha256 = sha256Hex(draft.invariantCdl);

  let runner: TeethRunner;
  let toolchain: ResolvedToolchain;
  try {
    // The language is inferred from the test filename extension; the runner owns
    // toolchain location and the per-revision run command. deps.python is the
    // python-only test seam (inject the repo venv python in vitest). A missing
    // toolchain is an INFRA error (exit 1), never a TEETH_FAILED verdict, so a
    // missing interpreter can't masquerade as a toothless test.
    runner = resolveTeethRunner(testBasename);
    toolchain = runner.locate(
      projectDir,
      runner.language === "python" ? deps.python : undefined,
    );
  } catch (error) {
    fail((error as Error).message);
    return;
  }

  let parentRun: WorktreeRun;
  let fixRun: WorktreeRun;
  try {
    ({ parentRun, fixRun } = runCandidateInWorktrees(projectDir, {
      tmpLabel: id,
      parentSha,
      fixSha,
      testBasename,
      testBytes,
      runner,
      toolchain,
    }));
  } catch (error) {
    fail((error as Error).message);
    return;
  }

  const { verdict, parentBiteClass } = deriveTeethVerdict(parentRun, fixRun, runner);

  const proof: TeethProof = {
    verdict,
    parentSha,
    fixSha,
    testSha256,
    invariantSha256,
    parentBiteClass,
    parentRun,
    fixRun,
    producedAtFromGit,
  };
  writeTeethProof(projectDir, id, proof);

  out.write(`Teeth verdict: ${verdict}\n`);
  out.write(`  parent ${parentSha}  exit=${parentRun.exit}  (${parentBiteClass})\n`);
  out.write(`  fix    ${fixSha}  exit=${fixRun.exit}\n`);
  out.write(`  testSha256 ${testSha256}\n`);
  out.write(`  proof  .stele/proofs/${id}/teeth.json\n`);
  if (verdict === "TEETH_PROVEN") {
    out.write(`\nNext: stele incident approve --id ${id}\n`);
  } else if (parentRun.exit !== 0 && fixRun.exit === 0 && parentBiteClass === "collection-or-build") {
    out.write(
      `\nNot proven: the test FAILED at <fix>^ only because it could not be ` +
        `collected/compiled (it never ran its assertions). Write the negative test ` +
        `against an entry point that exists at BOTH <fix>^ and <fix>, then re-run.\n`,
    );
  } else {
    out.write(
      `\nNot proven: the test must FAIL at <fix>^ AND PASS at <fix>. ` +
        `Revise the negative test and re-run draft.\n`,
    );
  }
}

/**
 * Attach the `teeth` subcommand to the shared `incident` parent (created once in
 * incident/index.ts). Mirrors the draft registration idiom.
 */
export function registerIncidentTeeth(incident: Command): void {
  incident
    .command(commandName("teeth"))
    .description(
      "Prove the candidate negative test FAILS at <fix>^ AND PASSES at <fix> in isolated worktrees. Writes only to .stele/proofs/<id>/.",
    )
    .requiredOption("--id <id>", "incident id (from `stele incident draft`)")
    .action(async (opts: { id: string }) => {
      await runIncidentTeeth(process.cwd(), { id: opts.id });
    });
}
