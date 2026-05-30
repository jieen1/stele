import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type IncidentDraft,
  writeCandidateTest,
  writeDraftJson,
} from "../src/commands/incident/shared.js";
import { runIncidentTeeth } from "../src/commands/incident/teeth.js";

const OLD_DATE = "2021-01-02T03:04:05+00:00";

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
  }).trim();
}

function commit(cwd: string, message: string, date: string): string {
  const env = {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  git(cwd, ["add", "-A"], env);
  git(cwd, ["commit", "-m", message], env);
  return git(cwd, ["rev-parse", "HEAD"]);
}

type Fixture = {
  dir: string;
  parentSha: string;
  fixSha: string;
};

/**
 * Build a git repo with a real bug fixed by HEAD:
 *   parent commit: src/calc.py returns a + a (buggy)
 *   fix commit:    src/calc.py returns a + b (correct)
 * The candidate negative test asserts the FIXED behaviour, so it FAILS at the
 * parent and PASSES at the fix.
 */
function makeProvenFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "stele-teeth-fixture-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  mkdirSync(join(dir, "src"), { recursive: true });
  // empty __init__ so `import src.calc` works from worktree root.
  writeFileSync(join(dir, "src", "__init__.py"), "");
  writeFileSync(join(dir, "src", "calc.py"), "def add(a, b):\n    return a + a\n");
  const parentSha = commit(dir, "buggy add", OLD_DATE);

  writeFileSync(join(dir, "src", "calc.py"), "def add(a, b):\n    return a + b\n");
  const fixSha = commit(dir, "fix add", OLD_DATE);

  return { dir, parentSha, fixSha };
}

async function seedDraft(
  dir: string,
  id: string,
  fixture: Fixture,
  negativeTest: string,
  testFilename = `test_incident_${id}.py`,
): Promise<IncidentDraft> {
  const draft: IncidentDraft = {
    intent: "fix add returns sum",
    fixSha: fixture.fixSha,
    parentSha: fixture.parentSha,
    invariantCdl: '(invariant test (always true))',
    negativeTest,
    testFilename,
  };
  await writeDraftJson(dir, id, draft);
  await writeCandidateTest(dir, id, draft);
  return draft;
}

function readTeeth(dir: string, id: string): Record<string, unknown> {
  const path = join(dir, ".stele", "proofs", id, "teeth.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256Hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function leftoverWorktrees(dir: string): string[] {
  const out = git(dir, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p !== dir);
}

/**
 * Find a python interpreter that actually has pytest installed, so the
 * worktree-run tests exercise the real proof path. Prefer the repo venv (the
 * only interpreter guaranteed to have pytest), then probe `python`/`python3`.
 * Returns undefined when no pytest-capable interpreter exists -> those describes
 * skip. We inject the result via deps.python so the test does not depend on the
 * throwaway fixture repos having their own .venv.
 */
function pytestCapablePython(): string | undefined {
  const repoVenv = join(REPO_ROOT, ".venv", "bin", "python");
  const candidates = [repoVenv, "python", "python3"];
  for (const c of candidates) {
    try {
      execFileSync(c, ["-m", "pytest", "--version"], { stdio: "ignore" });
      return c;
    } catch {
      // not capable; try next
    }
  }
  return undefined;
}

// tests/ -> packages/cli -> packages -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEST_PYTHON = pytestCapablePython();
const describePy = TEST_PYTHON ? describe : describe.skip;

let createdDirs: string[] = [];

function track(dir: string): string {
  createdDirs.push(dir);
  return dir;
}

beforeEach(() => {
  createdDirs = [];
  process.exitCode = 0;
});

afterEach(() => {
  for (const dir of createdDirs) {
    try {
      // prune any worktrees first so rm doesn't leave git metadata strays.
      git(dir, ["worktree", "prune"]);
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exitCode = 0;
});

describePy("runIncidentTeeth — verdict logic", () => {
  it("PROVEN: test fails at parent, passes at fix", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "proven-case";
    const test = "from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
    await seedDraft(f.dir, id, f, test);

    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });

    expect(process.exitCode).toBe(0);
    const teeth = readTeeth(f.dir, id);
    expect(teeth.verdict).toBe("TEETH_PROVEN");
    expect(teeth.fixSha).toBe(f.fixSha);
    expect(teeth.parentSha).toBe(f.parentSha);
    // parentSha is exactly fix^.
    expect(teeth.parentSha).toBe(git(f.dir, ["rev-parse", `${f.fixSha}^`]));
    expect((teeth.parentRun as { exit: number }).exit).not.toBe(0);
    expect((teeth.fixRun as { exit: number }).exit).toBe(0);
  });

  it("FAILED: vacuous always-pass test (no teeth)", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "vacuous-case";
    const test = "def test_x():\n    assert True\n";
    await seedDraft(f.dir, id, f, test);

    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });

    expect(process.exitCode).toBe(0);
    const teeth = readTeeth(f.dir, id);
    expect(teeth.verdict).toBe("TEETH_FAILED");
    expect((teeth.parentRun as { exit: number }).exit).toBe(0);
    expect((teeth.fixRun as { exit: number }).exit).toBe(0);
  });

  it("FAILED: test fails at BOTH revs", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "always-fail";
    const test = "def test_x():\n    assert False\n";
    await seedDraft(f.dir, id, f, test);

    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });

    expect(process.exitCode).toBe(0);
    const teeth = readTeeth(f.dir, id);
    expect(teeth.verdict).toBe("TEETH_FAILED");
    expect((teeth.parentRun as { exit: number }).exit).not.toBe(0);
    expect((teeth.fixRun as { exit: number }).exit).not.toBe(0);
  });
});

describePy("runIncidentTeeth — determinism", () => {
  it("producedAtFromGit equals the fix committer date, byte-identical across runs", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "determinism";
    const test = "from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
    await seedDraft(f.dir, id, f, test);

    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });
    const first = readTeeth(f.dir, id);
    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });
    const second = readTeeth(f.dir, id);

    const expected = git(f.dir, ["show", "-s", "--format=%cI", f.fixSha]);
    expect(first.producedAtFromGit).toBe(expected);
    expect(second.producedAtFromGit).toBe(first.producedAtFromGit);
    // Old fixture date — provably not the wall clock.
    expect(String(first.producedAtFromGit).startsWith("2021-01-02")).toBe(true);
    expect(new Date(String(first.producedAtFromGit)).getFullYear()).toBe(2021);
  });

  it("testSha256 binds the candidate test bytes", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "testsha";
    const test = "from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
    await seedDraft(f.dir, id, f, test);

    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });

    const teeth = readTeeth(f.dir, id);
    expect(teeth.testSha256).toBe(sha256Hex(test));
  });
});

describePy("runIncidentTeeth — worktree lifecycle", () => {
  it("removes both worktrees on success", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "cleanup-ok";
    const test = "from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
    await seedDraft(f.dir, id, f, test);

    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });

    expect(leftoverWorktrees(f.dir)).toEqual([]);
  });

  it("scratch isolation: writes only under .stele/proofs/<id>", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "isolation";
    const test = "from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
    await seedDraft(f.dir, id, f, test);

    const before = git(f.dir, ["status", "--porcelain"]);
    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });
    const after = git(f.dir, ["status", "--porcelain"]);

    // Only .stele scratch should appear; src/ and committed files untouched.
    expect(after).toBe(before);
    expect(existsSync(join(f.dir, ".stele", "proofs", id, "teeth.json"))).toBe(true);
  });
});

describe("runIncidentTeeth — infra errors (exit 1, no python needed)", () => {
  it("missing draft.json -> exit 1", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "stele-teeth-nodraft-")));
    git(dir, ["init", "-q"]);
    await runIncidentTeeth(dir, { id: "nope" });
    expect(process.exitCode).toBe(1);
  });

  it("unsafe testFilename in draft -> exit 1, no escape", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "unsafe-name";
    // Bypass parseDraftInput by writing draft.json directly with a hostile name.
    mkdirSync(join(f.dir, ".stele", "incident", id), { recursive: true });
    writeFileSync(
      join(f.dir, ".stele", "incident", id, "draft.json"),
      JSON.stringify(
        {
          intent: "x",
          fixSha: f.fixSha,
          parentSha: f.parentSha,
          invariantCdl: "(invariant x (always true))",
          negativeTest: "def test(): pass\n",
          testFilename: "../escape.py",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await runIncidentTeeth(f.dir, { id }, { python: TEST_PYTHON });
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(f.dir, "..", "escape.py"))).toBe(false);
    expect(leftoverWorktrees(f.dir)).toEqual([]);
  });
});

describePy("runIncidentTeeth — cleanup on error", () => {
  it("missing python binary mid-run -> exit 1 AND worktrees removed", async () => {
    const f = makeProvenFixture();
    track(f.dir);
    const id = "py-missing";
    const test = "from src.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n";
    await seedDraft(f.dir, id, f, test);

    // Plant a non-functional .venv/bin/python so locatePython picks it, then the
    // run throws ENOENT-equivalent -> infra error; the finally must still clean
    // up both worktrees.
    const venvBin = join(f.dir, ".venv", "bin");
    mkdirSync(venvBin, { recursive: true });
    // a directory named 'python' is not executable -> spawn fails.
    mkdirSync(join(venvBin, "python"));

    await runIncidentTeeth(f.dir, { id });

    expect(process.exitCode).toBe(1);
    expect(leftoverWorktrees(f.dir)).toEqual([]);
  });
});
