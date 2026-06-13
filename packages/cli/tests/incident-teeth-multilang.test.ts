// P1-2: the teeth gate is language-agnostic. These tests prove the verdict path
// works through a real worktree run for JavaScript (node:test), TypeScript
// (node --test --experimental-strip-types), and Rust (cargo test), plus unit
// tests for the runner-dispatch + filename-validation logic.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type IncidentDraft,
  writeCandidateTest,
  writeDraftJson,
} from "../src/commands/incident/shared.js";
import { runIncidentTeeth } from "../src/commands/incident/teeth.js";
import {
  assertSafeTestBasename,
  inferTeethLanguage,
  resolveTeethRunner,
} from "../src/commands/incident/teeth-runners.js";

const OLD_DATE = "2021-01-02T03:04:05+00:00";

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
  }).trim();
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

type Fixture = { dir: string; parentSha: string; fixSha: string };

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "stele-teeth-ml-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

/**
 * Build a repo where HEAD fixes a bug: `add(a,b)` returns `a+a` at the parent,
 * `a+b` at the fix. `buggy`/`fixed` are the file body at each revision. The
 * candidate negative test asserts the fixed behaviour, so it FAILS at the parent
 * and PASSES at the fix.
 */
function makeFixture(files: (body: string) => Record<string, string>, buggy: string, fixed: string): Fixture {
  const dir = initRepo();
  for (const [rel, content] of Object.entries(files(buggy))) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const parentSha = commit(dir, "buggy");
  for (const [rel, content] of Object.entries(files(fixed))) {
    writeFileSync(join(dir, rel), content);
  }
  const fixSha = commit(dir, "fix");
  return { dir, parentSha, fixSha };
}

async function seedDraft(
  f: Fixture,
  id: string,
  negativeTest: string,
  testFilename: string,
): Promise<void> {
  const draft: IncidentDraft = {
    intent: "fix add",
    fixSha: f.fixSha,
    parentSha: f.parentSha,
    invariantCdl: "(invariant t (always true))",
    negativeTest,
    testFilename,
  };
  await writeDraftJson(f.dir, id, draft);
  await writeCandidateTest(f.dir, id, draft);
}

function readTeeth(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".stele", "proofs", id, "teeth.json"), "utf8"));
}

function toolAvailable(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_CARGO = toolAvailable("cargo", ["--version"]);
const HAS_STRIP_TYPES = toolAvailable(process.execPath, ["--experimental-strip-types", "-e", ""]);

const created: string[] = [];
beforeEach(() => {
  process.exitCode = 0;
});
afterEach(() => {
  for (const dir of created) {
    try {
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
  created.length = 0;
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// Integration: real worktree runs per language
// ---------------------------------------------------------------------------

describe("teeth — JavaScript (node:test)", () => {
  it(
    "PROVEN: a .mjs test fails at parent, passes at fix",
    async () => {
      const f = makeFixture(
        (body) => ({ "src/calc.mjs": `export function add(a, b) { return ${body}; }\n` }),
        "a + a",
        "a + b",
      );
      created.push(f.dir);
      const id = "js-proven";
      const test =
        'import { test } from "node:test";\n' +
        'import assert from "node:assert";\n' +
        'import { add } from "./src/calc.mjs";\n' +
        'test("add", () => { assert.strictEqual(add(1, 2), 3); });\n';
      await seedDraft(f, id, test, `incident_${id}.mjs`);

      await runIncidentTeeth(f.dir, { id });

      expect(process.exitCode).toBe(0);
      const teeth = readTeeth(f.dir, id);
      expect(teeth.verdict).toBe("TEETH_PROVEN");
      expect((teeth.parentRun as { exit: number }).exit).not.toBe(0);
      expect((teeth.fixRun as { exit: number }).exit).toBe(0);
    },
    30_000,
  );
});

(HAS_STRIP_TYPES ? describe : describe.skip)("teeth — TypeScript (strip-types)", () => {
  it(
    "PROVEN: a .ts test fails at parent, passes at fix",
    async () => {
      const f = makeFixture(
        (body) => ({
          "src/calc.ts": `export function add(a: number, b: number): number { return ${body}; }\n`,
        }),
        "a + a",
        "a + b",
      );
      created.push(f.dir);
      const id = "ts-proven";
      const test =
        'import { test } from "node:test";\n' +
        'import assert from "node:assert";\n' +
        'import { add } from "./src/calc.ts";\n' +
        'test("add", () => { assert.strictEqual(add(1, 2), 3); });\n';
      await seedDraft(f, id, test, `incident_${id}.ts`);

      await runIncidentTeeth(f.dir, { id });

      expect(process.exitCode).toBe(0);
      const teeth = readTeeth(f.dir, id);
      expect(teeth.verdict).toBe("TEETH_PROVEN");
    },
    30_000,
  );
});

(HAS_CARGO ? describe : describe.skip)("teeth — Rust (cargo test)", () => {
  it(
    "PROVEN: a tests/*.rs integration test fails at parent, passes at fix",
    async () => {
      const f = makeFixture(
        (body) => ({
          "Cargo.toml":
            '[package]\nname = "calc"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
          "src/lib.rs": `pub fn add(a: i32, b: i32) -> i32 { ${body} }\n`,
        }),
        "a + a",
        "a + b",
      );
      created.push(f.dir);
      const id = "rs-proven";
      const test = "#[test]\nfn add_is_sum() { assert_eq!(calc::add(1, 2), 3); }\n";
      // Rust test stem must be a valid crate name (underscores, no hyphens).
      await seedDraft(f, id, test, "incident_rs_proven.rs");

      await runIncidentTeeth(f.dir, { id });

      expect(process.exitCode).toBe(0);
      const teeth = readTeeth(f.dir, id);
      expect(teeth.verdict).toBe("TEETH_PROVEN");
      expect((teeth.parentRun as { exit: number }).exit).not.toBe(0);
      expect((teeth.fixRun as { exit: number }).exit).toBe(0);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Unit: runner dispatch + filename validation (no toolchains needed)
// ---------------------------------------------------------------------------

describe("inferTeethLanguage", () => {
  it("maps extensions to languages", () => {
    expect(inferTeethLanguage("t.py")).toBe("python");
    expect(inferTeethLanguage("t.ts")).toBe("typescript");
    expect(inferTeethLanguage("t.mts")).toBe("typescript");
    expect(inferTeethLanguage("t.mjs")).toBe("javascript");
    expect(inferTeethLanguage("t.cjs")).toBe("javascript");
    expect(inferTeethLanguage("t.js")).toBe("javascript");
    expect(inferTeethLanguage("t.rs")).toBe("rust");
  });
  it("returns null for unsupported extensions", () => {
    expect(inferTeethLanguage("t.go")).toBeNull();
    expect(inferTeethLanguage("t.java")).toBeNull();
    expect(inferTeethLanguage("t.txt")).toBeNull();
  });
});

describe("assertSafeTestBasename", () => {
  it("accepts supported runnable extensions", () => {
    for (const name of ["test_x.py", "x.ts", "x.mjs", "x.cjs", "x.js", "x.rs"]) {
      expect(assertSafeTestBasename(name)).toBe(name);
    }
  });
  it("rejects path separators / traversal", () => {
    expect(() => assertSafeTestBasename("../e.py")).toThrow(/separators/);
    expect(() => assertSafeTestBasename("sub/t.py")).toThrow(/separators/);
  });
  it("rejects Go / Java with a language-specific message", () => {
    expect(() => assertSafeTestBasename("t.go")).toThrow(/Go is not yet supported/);
    expect(() => assertSafeTestBasename("t.java")).toThrow(/Java is not yet supported/);
  });
  it("rejects unknown extensions naming the supported set", () => {
    expect(() => assertSafeTestBasename("t.txt")).toThrow(/\.py, \.ts/);
  });
  it("rejects a .rs filename whose stem is not a valid cargo --test crate name", () => {
    expect(() => assertSafeTestBasename("foo.bar.rs")).toThrow(/crate name/);
    expect(() => assertSafeTestBasename("foo-bar.rs")).toThrow(/crate name/);
    expect(assertSafeTestBasename("foo_bar.rs")).toBe("foo_bar.rs");
  });
});

describe("resolveTeethRunner", () => {
  it("python places at root and runs pytest", () => {
    const r = resolveTeethRunner("t.py");
    expect(r.language).toBe("python");
    expect(r.placement("t.py")).toBe("t.py");
    const { args } = r.buildRun({ bin: "python" }, "t.py", "/wt");
    expect(args).toContain("pytest");
    expect(args).toContain("--rootdir=/wt");
  });
  it("javascript runs node --test without strip-types", () => {
    const r = resolveTeethRunner("t.mjs");
    const { args } = r.buildRun({ bin: "node" }, "t.mjs", "/wt");
    expect(args).toContain("--test");
    expect(args).not.toContain("--experimental-strip-types");
  });
  it("typescript adds --experimental-strip-types", () => {
    const r = resolveTeethRunner("t.ts");
    const { args } = r.buildRun({ bin: "node" }, "t.ts", "/wt");
    expect(args).toContain("--experimental-strip-types");
    expect(args).toContain("--test");
  });
  it("rust places under tests/ and runs cargo test --test <stem>", () => {
    const r = resolveTeethRunner("t.rs");
    expect(r.placement("t.rs")).toBe(join("tests", "t.rs"));
    const { args } = r.buildRun({ bin: "cargo" }, join("tests", "t.rs"), "/wt");
    expect(args).toEqual(["test", "--test", "t", "--quiet"]);
  });
});

describe("classifyFailure (B2 bite-strength)", () => {
  it("python: real assertion failure vs collection/import error vs unknown", () => {
    const py = resolveTeethRunner("t.py");
    expect(py.classifyFailure("E   assert 2 == 3\n1 failed in <duration>")).toBe("assertion");
    expect(py.classifyFailure("E   AssertionError\n1 failed in <duration>")).toBe("assertion");
    expect(py.classifyFailure("E   ModuleNotFoundError: No module named 'x'\nerrors during collection")).toBe(
      "collection-or-build",
    );
    expect(py.classifyFailure("ImportError: cannot import name 'guard'")).toBe("collection-or-build");
    // A genuine test failure ALWAYS wins even if the word 'error' appears.
    expect(py.classifyFailure("1 failed\nsome error text")).toBe("assertion");
    expect(py.classifyFailure("weird unrecognized output")).toBe("unknown");
    // FALSE-GREEN GUARD: an import-time AssertionError surfaces as a COLLECTION
    // error (no "N failed") — it must NOT be classified 'assertion' (which would
    // fall back to the exit-code rule and re-open a hollow proof).
    expect(
      py.classifyFailure("E   AssertionError: bad config\n1 error during collection\nERROR collecting conf.py"),
    ).toBe("collection-or-build");
  });
  it("node: assertion vs module-load error vs unknown", () => {
    const js = resolveTeethRunner("t.mjs");
    expect(js.classifyFailure("not ok 1 - add\n  AssertionError")).toBe("assertion");
    expect(js.classifyFailure("# fail 1\nnot ok 1 - x")).toBe("assertion");
    // A load error wraps the file as a failing test (not ok present) but is a build class.
    expect(js.classifyFailure("not ok 1 - t.mjs\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'")).toBe(
      "collection-or-build",
    );
    expect(js.classifyFailure("SyntaxError: Unexpected token")).toBe("collection-or-build");
    expect(js.classifyFailure("nothing recognizable")).toBe("unknown");
    // FALSE-REJECT GUARD: a GENUINE assertion failure whose echoed value contains
    // a build token must classify 'assertion' (ERR_ASSERTION/AssertionError win).
    expect(
      js.classifyFailure(
        "not ok 1 - rejects bad input\n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: \"Cannot find module 'x'\"\n# fail 1",
      ),
    ).toBe("assertion");
    expect(
      js.classifyFailure("not ok 1 - throws\n  name: 'AssertionError'\n  Missing expected exception (SyntaxError).\n# fail 1"),
    ).toBe("assertion");
  });
  it("rust: assertion/panic vs compile error vs unknown", () => {
    const rs = resolveTeethRunner("t.rs");
    expect(rs.classifyFailure("test result: FAILED. 0 passed; 1 failed")).toBe("assertion");
    expect(rs.classifyFailure("thread 'main' panicked at ...")).toBe("assertion");
    expect(rs.classifyFailure("error[E0425]: cannot find value `x`\nerror: could not compile `calc`")).toBe(
      "collection-or-build",
    );
    expect(rs.classifyFailure("could not compile `calc`")).toBe("collection-or-build");
    expect(rs.classifyFailure("???")).toBe("unknown");
    // FALSE-REJECT GUARD: a genuine panic whose message embeds a compile token
    // (the test asserts on a diagnostic string) must classify 'assertion'.
    expect(
      rs.classifyFailure(
        "thread 'main' panicked at src/lib.rs: assertion `left == right` failed\n  right: \"error[E0425]: could not compile\"\ntest result: FAILED. 0 passed; 1 failed",
      ),
    ).toBe("assertion");
  });
});
