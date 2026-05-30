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
import { basename, delimiter, join } from "node:path";

import type { Command } from "commander";

import { ExitCode } from "../../errors.js";
import {
  type IncidentDraft,
  fixCommitterDate,
  incidentScratchDir,
  proofsScratchDir,
  readDraftJson,
} from "./shared.js";

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
 * to the exact candidate-test bytes copied byte-identically into both worktrees.
 */
export type TeethProof = {
  verdict: TeethVerdict;
  parentSha: string;
  fixSha: string;
  testSha256: string;
  parentRun: RunResult;
  fixRun: RunResult;
  producedAtFromGit: string;
};

export type IncidentTeethOptions = { id: string; runLocal?: boolean };

const TEST_FILENAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*\.py$/;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Defense-in-depth path safety for the candidate test filename (the bytes come
 * from agent-supplied draft.json). Mirrors addChecker's idiom: the basename must
 * match a bare *.py pattern AND equal its own basename (no separators, not
 * absolute), so the file copied into each worktree can never escape the worktree
 * root. shared.parseDraftInput already enforces this at draft time; we re-check
 * here because teeth reads draft.json from disk and must not trust it blindly.
 */
function safeTestBasename(testFilename: string): string {
  const name = basename(testFilename);
  if (
    name !== testFilename ||
    !TEST_FILENAME_PATTERN.test(name) ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(
      `Unsafe testFilename ${JSON.stringify(testFilename)} in draft.json: ` +
        "must be a bare *.py filename with no path separators.",
    );
  }
  return name;
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
 * Locate the python interpreter. Prefer the repo venv so the worktree's own
 * source at that SHA is imported with the project's dependencies; otherwise fall
 * back to `python`, then `python3`, on PATH. Absence of ALL is an INFRA error
 * (caller maps to exit 1) — never a TEETH_FAILED verdict, so a missing
 * interpreter can't masquerade as a toothless test.
 */
function locatePython(projectDir: string): string {
  const venvPython = join(projectDir, ".venv", "bin", "python");
  if (existsSync(venvPython)) {
    return venvPython;
  }
  if (binaryOnPath("python")) {
    return "python";
  }
  if (binaryOnPath("python3")) {
    return "python3";
  }
  throw new Error(
    "No python interpreter found (.venv/bin/python, python, python3 all absent); cannot run teeth.",
  );
}

function binaryOnPath(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the candidate test at one revision inside its isolated worktree. The test
 * is written to a NON-tracked path at the worktree root (it cannot collide with
 * a tracked file at the historical SHA), then pytest runs with cwd = worktree
 * root so imports resolve against that revision's source. "Fails" means non-zero
 * exit — that includes both an assertion failure AND a pytest collection/import
 * error (e.g. the test imports a module that only exists at <fix>); both are
 * legitimate "the bug was reproducible at the parent" signals.
 */
function runTestInWorktree(
  python: string,
  worktreeDir: string,
  testBasename: string,
  testBytes: Buffer,
): RunResult {
  const testPath = join(worktreeDir, testBasename);
  writeFileSync(testPath, testBytes);

  let exit: number;
  let stdout = "";
  let stderr = "";
  try {
    // PYTHONPATH = worktree root so a candidate test can `import <pkg>` against
    // the revision's own source regardless of pytest's sys.path/import-mode
    // policy (some pytest configs do NOT prepend the test file's dir). Prepend
    // to any inherited PYTHONPATH rather than clobbering it.
    const inheritedPyPath = process.env.PYTHONPATH;
    const pythonPath = inheritedPyPath
      ? `${worktreeDir}${delimiter}${inheritedPyPath}`
      : worktreeDir;
    // --noconftest: the candidate negative test is a single self-contained file
    // and must NOT load an ancestor conftest.py (pytest otherwise walks up the
    // filesystem from rootdir loading every conftest, which can import host-repo
    // modules absent in the isolated worktree). --rootdir pins discovery to the
    // worktree; -p no:cacheprovider keeps a .pytest_cache out of it.
    stdout = execFileSync(
      python,
      [
        "-m",
        "pytest",
        testBasename,
        "-q",
        "--noconftest",
        "-p",
        "no:cacheprovider",
        `--rootdir=${worktreeDir}`,
      ],
      {
        cwd: worktreeDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: pythonPath },
      },
    );
    exit = 0;
  } catch (error) {
    const err = error as {
      status?: number | null;
      code?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    if (err.code === "ENOENT") {
      // python binary itself is missing — INFRA error, not a verdict.
      throw new Error(
        `Python interpreter ${JSON.stringify(python)} not found; cannot run teeth.`,
      );
    }
    if (typeof err.status === "number") {
      exit = err.status;
    } else {
      // Killed by signal / no numeric status — treat as infra failure.
      throw new Error(
        `pytest did not exit with a numeric status (signal?); cannot determine verdict.`,
      );
    }
    stdout = err.stdout ? err.stdout.toString() : "";
    stderr = err.stderr ? err.stderr.toString() : "";
  }

  const combined = Buffer.concat([
    Buffer.from(stdout, "utf8"),
    Buffer.from(stderr, "utf8"),
  ]);
  return { exit, outputSha256: sha256Hex(combined) };
}

function serializeTeeth(proof: TeethProof): string {
  // Fixed key order — byte-stable.
  const ordered = {
    verdict: proof.verdict,
    parentSha: proof.parentSha,
    fixSha: proof.fixSha,
    testSha256: proof.testSha256,
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

    testBasename = safeTestBasename(draft.testFilename);
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

  let python: string;
  try {
    // deps.python is the test seam (inject the repo venv python in vitest);
    // production resolves .venv/bin/python -> python -> python3. A missing
    // interpreter is an INFRA error (exit 1), never a TEETH_FAILED verdict.
    python = deps.python ?? locatePython(projectDir);
  } catch (error) {
    fail((error as Error).message);
    return;
  }

  // Unique ephemeral base per invocation: `git worktree add` refuses a path
  // that already exists, and reusing a deterministic name collides across
  // back-to-back runs (same fix SHA -> same name). The dir is removed in the
  // finally, so the random suffix has NO effect on any teeth.json output —
  // determinism lives entirely in producedAtFromGit/testSha256, not here.
  const sha8 = (s: string): string => s.slice(0, 8);
  const base = mkdtempSync(join(tmpdir(), `stele-incident-${id}-`));
  const parentDir = join(base, `parent-${sha8(parentSha)}`);
  const fixDir = join(base, `fix-${sha8(fixSha)}`);

  let parentAdded = false;
  let fixAdded = false;
  try {
    addWorktree(projectDir, parentDir, parentSha);
    parentAdded = true;
    addWorktree(projectDir, fixDir, fixSha);
    fixAdded = true;

    const parentRun = runTestInWorktree(python, parentDir, testBasename, testBytes);
    const fixRun = runTestInWorktree(python, fixDir, testBasename, testBytes);

    // Verdict from exit codes ONLY: a vacuous always-pass test passes at BOTH
    // revs (parent exit 0) → not proven → TEETH_FAILED.
    const verdict: TeethVerdict =
      parentRun.exit !== 0 && fixRun.exit === 0 ? "TEETH_PROVEN" : "TEETH_FAILED";

    const proof: TeethProof = {
      verdict,
      parentSha,
      fixSha,
      testSha256,
      parentRun,
      fixRun,
      producedAtFromGit,
    };
    writeTeethProof(projectDir, id, proof);

    out.write(`Teeth verdict: ${verdict}\n`);
    out.write(`  parent ${parentSha}  exit=${parentRun.exit}\n`);
    out.write(`  fix    ${fixSha}  exit=${fixRun.exit}\n`);
    out.write(`  testSha256 ${testSha256}\n`);
    out.write(`  proof  .stele/proofs/${id}/teeth.json\n`);
    if (verdict === "TEETH_PROVEN") {
      out.write(`\nNext: stele incident approve --id ${id}\n`);
    } else {
      out.write(
        `\nNot proven: the test must FAIL at <fix>^ AND PASS at <fix>. ` +
          `Revise the negative test and re-run draft.\n`,
      );
    }
    // teeth ran — exit 0 regardless of verdict.
  } catch (error) {
    fail((error as Error).message);
  } finally {
    // ALWAYS remove BOTH worktrees, each in its own try/catch, then prune so a
    // failure removing one never strands the other.
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
 * Attach the `teeth` subcommand to the shared `incident` parent (created once in
 * incident/index.ts). Mirrors the draft registration idiom.
 */
export function registerIncidentTeeth(incident: Command): void {
  incident
    .command("teeth")
    .description(
      "Prove the candidate negative test FAILS at <fix>^ AND PASSES at <fix> in isolated worktrees. Writes only to .stele/proofs/<id>/.",
    )
    .requiredOption("--id <id>", "incident id (from `stele incident draft`)")
    .option("--run-local", "reserved; teeth always runs in isolated worktrees")
    .action(async (opts: { id: string; runLocal?: boolean }) => {
      await runIncidentTeeth(process.cwd(), { id: opts.id, runLocal: opts.runLocal });
    });
}
