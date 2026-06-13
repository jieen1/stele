// B3: `stele incident reverify` — re-derive a locked teeth verdict from git +
// the committed provenance record. Three outcomes: reproduced / contradicted /
// infra (could-not-reproduce).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ProvenanceRecord, writeProvenance } from "../src/commands/incident/provenance.js";
import { runIncidentReverify } from "../src/commands/incident/reverify.js";

const OLD_DATE = "2021-01-02T03:04:05+00:00";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(env ?? {}) } }).trim();
}
function commit(cwd: string, message: string): string {
  const env = {
    GIT_AUTHOR_DATE: OLD_DATE,
    GIT_COMMITTER_DATE: OLD_DATE,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  git(cwd, ["add", "-A"], env);
  git(cwd, ["commit", "-q", "-m", message], env);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function pytestCapablePython(): string | undefined {
  const repoVenv = join(REPO_ROOT, ".venv", "bin", "python");
  for (const c of [repoVenv, "python", "python3"]) {
    try {
      execFileSync(c, ["-m", "pytest", "--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}
const TEST_PYTHON = pytestCapablePython();
const describePy = TEST_PYTHON ? describe : describe.skip;

const dirs: string[] = [];
function makeBugFixRepo(): { dir: string; parentSha: string; fixSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "stele-reverify-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "__init__.py"), "");
  writeFileSync(join(dir, "src", "calc.py"), "def add(a, b):\n    return a + a\n");
  const parentSha = commit(dir, "buggy");
  writeFileSync(join(dir, "src", "calc.py"), "def add(a, b):\n    return a + b\n");
  const fixSha = commit(dir, "fix");
  return { dir, parentSha, fixSha };
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
function record(over: Partial<ProvenanceRecord> & Pick<ProvenanceRecord, "parentSha" | "fixSha">): ProvenanceRecord {
  const negativeTest =
    over.negativeTest ?? "from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
  const invariantCdl = over.invariantCdl ?? "(invariant r (severity error) (assert (eq 1 1)))\n";
  return {
    schemaVersion: 1,
    incidentId: over.incidentId ?? "case",
    invariantId: "r",
    parentSha: over.parentSha,
    fixSha: over.fixSha,
    testFilename: "test_incident_case.py",
    negativeTest,
    testSha256: over.testSha256 ?? sha(negativeTest),
    invariantCdl,
    invariantSha256: over.invariantSha256 ?? sha(invariantCdl),
    verdict: over.verdict ?? "TEETH_PROVEN",
    parentBiteClass: over.parentBiteClass ?? "assertion",
    producedAtFromGit: OLD_DATE,
  };
}

function capture(): { out: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  return {
    out: { write: (s: string) => ((buf += s), true) } as unknown as NodeJS.WritableStream,
    text: () => buf,
  };
}

beforeEach(() => {
  process.exitCode = 0;
});
afterEach(() => {
  for (const d of dirs) {
    try {
      git(d, ["worktree", "prune"]);
    } catch {
      /* ignore */
    }
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  dirs.length = 0;
  process.exitCode = 0;
});

describePy("runIncidentReverify", () => {
  it("reproduced: a genuine proof re-derives TEETH_PROVEN → exit 0", async () => {
    const f = makeBugFixRepo();
    const id = "case";
    await writeProvenance(f.dir, record({ incidentId: id, parentSha: f.parentSha, fixSha: f.fixSha }));
    const cap = capture();
    await runIncidentReverify(f.dir, { id }, { python: TEST_PYTHON, stdout: cap.out });
    expect(process.exitCode).toBe(0);
    expect(cap.text()).toMatch(/OK\s+case/);
  });

  it("contradicted: a vacuous test recorded as PROVEN re-derives FAILED → exit 2", async () => {
    const f = makeBugFixRepo();
    const id = "case";
    // A test that passes at BOTH revs (asserts nothing real) but the record
    // claims TEETH_PROVEN — re-run disagrees.
    await writeProvenance(
      f.dir,
      record({
        incidentId: id,
        parentSha: f.parentSha,
        fixSha: f.fixSha,
        negativeTest: "def test_x():\n    assert True\n",
      }),
    );
    const cap = capture();
    await runIncidentReverify(f.dir, { id }, { python: TEST_PYTHON, stdout: cap.out });
    expect(process.exitCode).toBe(2);
    expect(cap.text()).toMatch(/CONTRA\s+case/);
  });

  it("contradicted: a tampered record (testSha256 mismatch) → exit 2 without re-running", async () => {
    const f = makeBugFixRepo();
    const id = "case";
    await writeProvenance(
      f.dir,
      record({ incidentId: id, parentSha: f.parentSha, fixSha: f.fixSha, testSha256: "0".repeat(64) }),
    );
    const cap = capture();
    await runIncidentReverify(f.dir, { id }, { python: TEST_PYTHON, stdout: cap.out });
    expect(process.exitCode).toBe(2);
    expect(cap.text()).toMatch(/does not match recorded testSha256/);
  });

  it("infra: a SHA absent from the repo → exit 1 (could-not-reproduce, not a false contradiction)", async () => {
    const f = makeBugFixRepo();
    const id = "case";
    await writeProvenance(
      f.dir,
      record({ incidentId: id, parentSha: "a".repeat(40), fixSha: f.fixSha }),
    );
    const cap = capture();
    await runIncidentReverify(f.dir, { id }, { python: TEST_PYTHON, stdout: cap.out });
    expect(process.exitCode).toBe(1);
    expect(cap.text()).toMatch(/INFRA\s+case/);
  });

  it("reproduced: a recorded TEETH_FAILED that re-derives TEETH_FAILED → exit 0", async () => {
    const f = makeBugFixRepo();
    const id = "failcase";
    // Fails at BOTH revs (asserts nothing real) → re-derives TEETH_FAILED, which
    // MATCHES the recorded verdict → reproduced. Exercises the non-PROVEN equality.
    await writeProvenance(
      f.dir,
      record({
        incidentId: id,
        parentSha: f.parentSha,
        fixSha: f.fixSha,
        verdict: "TEETH_FAILED",
        negativeTest: "def test_x():\n    assert False\n",
      }),
    );
    const cap = capture();
    await runIncidentReverify(f.dir, { id }, { python: TEST_PYTHON, stdout: cap.out });
    expect(process.exitCode).toBe(0);
    expect(cap.text()).toMatch(/OK\s+failcase/);
  });

  it("--all: a contradiction is NOT masked by an infra-only record — exit 2 wins, both reported", async () => {
    const f = makeBugFixRepo();
    // (a) contradicted: vacuous test recorded PROVEN. (b) infra: absent SHA.
    await writeProvenance(
      f.dir,
      record({ incidentId: "contra", parentSha: f.parentSha, fixSha: f.fixSha, negativeTest: "def test_x():\n    assert True\n" }),
    );
    await writeProvenance(
      f.dir,
      record({ incidentId: "broken", parentSha: "a".repeat(40), fixSha: f.fixSha }),
    );
    const cap = capture();
    await runIncidentReverify(f.dir, { all: true }, { python: TEST_PYTHON, stdout: cap.out });
    // CONTRACT_FAIL (2) must win over the infra (1) record.
    expect(process.exitCode).toBe(2);
    expect(cap.text()).toMatch(/CONTRA\s+contra/);
    expect(cap.text()).toMatch(/INFRA\s+broken/);
  });
});

describe("runIncidentReverify — arg handling (no toolchain needed)", () => {
  it("--all with no provenance records prints a notice and exits 0", async () => {
    const f = makeBugFixRepo();
    const cap = capture();
    await runIncidentReverify(f.dir, { all: true }, { stdout: cap.out });
    expect(process.exitCode).toBe(0);
    expect(cap.text()).toMatch(/No incident provenance records/);
  });

  it("neither --id nor --all → exit 1 with guidance", async () => {
    const f = makeBugFixRepo();
    const cap = capture();
    await runIncidentReverify(f.dir, {}, { stdout: cap.out });
    expect(process.exitCode).toBe(1);
    expect(cap.text()).toMatch(/requires --id <id> or --all/);
  });
});
