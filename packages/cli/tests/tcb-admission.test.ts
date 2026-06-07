import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TCB ADMISSION GATE
//
// This test is the admission gate for the trusted computing base (TCB). Every
// verdict-bearing package and CLI command listed in `tcb.json` MUST be covered
// by at least one *biting* negative test, tagged inline with a comment of the
// form `// @tcb-negative <id>`. A tag only counts if the test block it sits on
// also contains a "fail-shape" — an assertion that proves the negative test
// would actually fail if the protected behavior regressed. A tag without teeth
// is decorative and does not satisfy the gate.
//
// The gate is fully deterministic: it reads files from disk, sorts every
// collection, and consults no clock, network, or environment.

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// packages/cli/tests -> packages/cli -> packages -> <repo root>
const REPO_ROOT = resolve(TEST_DIR, "..", "..", "..");
const TCB_PATH = join(REPO_ROOT, "tcb.json");

interface TcbRegistry {
  verdictBearing: {
    packages: string[];
    commands: string[];
  };
}

function readTcb(): TcbRegistry {
  const raw = readFileSync(TCB_PATH, "utf8");
  return JSON.parse(raw) as TcbRegistry;
}

function packageDirName(pkg: string): string {
  // "@stele/core" -> "core"
  return pkg.startsWith("@stele/") ? pkg.slice("@stele/".length) : pkg;
}

// ---- corpus discovery -----------------------------------------------------

function walkTestFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (name.endsWith(".test.ts") && !name.endsWith(".test-d.ts")) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function collectTsTestFiles(): string[] {
  const packagesDir = join(REPO_ROOT, "packages");
  const out: string[] = [];
  for (const pkg of readdirSync(packagesDir).sort()) {
    const testsDir = join(packagesDir, pkg, "tests");
    if (existsSync(testsDir) && statSync(testsDir).isDirectory()) {
      out.push(...walkTestFiles(testsDir));
    }
  }
  return out.sort();
}

const PYTHON_NEGATIVE = join(
  REPO_ROOT,
  "contract",
  "checker_impls",
  "test_negative.py",
);

// ---- tag + fail-shape extraction ------------------------------------------

const TAG_RE = /\/\/\s*@tcb-negative\s+(\S+)/g;
const PY_TAG_RE = /#\s*@tcb-negative\s+(\S+)/g;

// A fail-shape is an assertion proving the negative test would fail if the
// protected behavior regressed. Any one of these in the enclosing block counts.
const TS_FAIL_SHAPES: RegExp[] = [
  /\.ok\)\.toBe\(false\)/, // report.ok === false
  /toThrow/, // (rejects.)toThrow / toThrowError
  /\)\.toBe\(false\)/, // existsSync(...) === false (NOT written), eligibility false
  /\)\.toBe\([23]\)/, // exit code 2 or 3
  /exitCode\)\.toBe\([23]\)/, // explicit exit-code assertion
  /toHaveLength\(\s*[1-9]/, // non-empty violations
  /toBeGreaterThan\(\s*0\s*\)/, // non-empty violations
  /\.action\)\.toBe\("(?:deny|block)"\)/, // hook deny/block decision
  /expect(?:Denied|Blocked)\b/, // deny/block helper
  /isCheckCommandError\b/, // orchestration error-shape
];

const PY_FAIL_SHAPES: RegExp[] = [
  /_pass_if_false\(/, // tamper-bite: checker detected the violation
  /assert .*violation/i,
  /returncode\s*!=\s*0/,
  /returncode\s*==\s*2/,
];

// Find the body of the test block that the tag belongs to. We take the slice of
// source from the tag to the end of the brace-balanced block opened by the next
// `it(`/`test(` call after the tag. This is deterministic and robust to nesting.
function blockBodyAfter(source: string, tagIndex: number): string {
  const rest = source.slice(tagIndex);
  const callMatch = /\b(?:it|test)\s*(?:\.\w+)?\s*\(/.exec(rest);
  if (!callMatch) {
    // Tag with no following test call — return a small window so it cannot
    // accidentally pick up an unrelated block. This will fail the fail-shape
    // check, which is the correct outcome (a decorative tag).
    return rest.slice(0, 200);
  }
  const start = callMatch.index + callMatch[0].length - 1; // at the "("
  let depth = 0;
  let i = start;
  for (; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return rest.slice(callMatch.index, i);
}

function pyBlockBodyAfter(source: string, tagIndex: number): string {
  // Python: take from the tag to the start of the next top-level `def ` (or EOF).
  const rest = source.slice(tagIndex);
  const next = /\ndef\s+test_/g;
  next.lastIndex = 1; // skip the def the tag sits in
  const m = next.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}

interface TagHit {
  id: string;
  file: string;
  hasTeeth: boolean;
}

function extractTagsTs(file: string): TagHit[] {
  const source = readFileSync(file, "utf8");
  const hits: TagHit[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(source)) !== null) {
    const id = m[1]!;
    const body = blockBodyAfter(source, m.index);
    const hasTeeth = TS_FAIL_SHAPES.some((re) => re.test(body));
    hits.push({ id, file, hasTeeth });
  }
  return hits;
}

function extractTagsPy(file: string): TagHit[] {
  if (!existsSync(file)) return [];
  const source = readFileSync(file, "utf8");
  const hits: TagHit[] = [];
  let m: RegExpExecArray | null;
  PY_TAG_RE.lastIndex = 0;
  while ((m = PY_TAG_RE.exec(source)) !== null) {
    const id = m[1]!;
    const body = pyBlockBodyAfter(source, m.index);
    const hasTeeth = PY_FAIL_SHAPES.some((re) => re.test(body));
    hits.push({ id, file, hasTeeth });
  }
  return hits;
}

function collectAllTags(): TagHit[] {
  const hits: TagHit[] = [];
  for (const f of collectTsTestFiles()) {
    if (f.endsWith("tcb-admission.test.ts")) continue; // do not scan the gate itself
    hits.push(...extractTagsTs(f));
  }
  hits.push(...extractTagsPy(PYTHON_NEGATIVE));
  return hits;
}

// ---- the gate -------------------------------------------------------------

describe("TCB admission gate", () => {
  const tcb = readTcb();
  const tagHits = collectAllTags();
  // Only tags that actually bite count toward coverage.
  const bitingHits = tagHits.filter((h) => h.hasTeeth);

  const coveringIds = new Set(bitingHits.map((h) => h.id));
  const declaredIds = new Set([
    ...tcb.verdictBearing.packages,
    ...tcb.verdictBearing.commands,
  ]);

  it("(a) every verdict-bearing package exists in the workspace", () => {
    const missing: string[] = [];
    for (const pkg of [...tcb.verdictBearing.packages].sort()) {
      const dir = packageDirName(pkg);
      const pkgJson = join(REPO_ROOT, "packages", dir, "package.json");
      if (!existsSync(pkgJson)) {
        missing.push(pkg);
        continue;
      }
      const declaredName = JSON.parse(readFileSync(pkgJson, "utf8")).name;
      if (declaredName !== pkg) missing.push(`${pkg} (package.json name=${declaredName})`);
    }
    expect(missing, `verdict-bearing packages not found in workspace: ${missing.join(", ")}`).toEqual([]);
  });

  it("(b) at least one biting tag exists in the corpus", () => {
    // Sanity: the corpus must actually contain teeth, otherwise the gate is
    // trivially satisfiable by deleting all tags.
    expect(bitingHits.length).toBeGreaterThan(0);
  });

  it("(c) every verdict-bearing package id is covered by a biting negative test", () => {
    const uncovered = [...tcb.verdictBearing.packages].sort().filter((id) => !coveringIds.has(id));
    expect(uncovered, `uncovered verdict-bearing packages (need a biting @tcb-negative tag): ${uncovered.join(", ")}`).toEqual([]);
  });

  it("(c) every verdict-bearing command id is covered by a biting negative test", () => {
    const uncovered = [...tcb.verdictBearing.commands].sort().filter((id) => !coveringIds.has(id));
    expect(uncovered, `uncovered verdict-bearing commands (need a biting @tcb-negative tag): ${uncovered.join(", ")}`).toEqual([]);
  });

  it("(c') tags that name a verdict id but lack teeth do not falsely satisfy the gate", () => {
    // A tag present but toothless for a declared id is a defect: it looks like
    // coverage but is decorative. Surface it.
    const toothlessForDeclared = tagHits
      .filter((h) => !h.hasTeeth && declaredIds.has(h.id))
      .map((h) => `${h.id} @ ${h.file.slice(REPO_ROOT.length + 1)}`)
      .sort();
    expect(toothlessForDeclared, `decorative (toothless) tags for declared ids: ${toothlessForDeclared.join("; ")}`).toEqual([]);
  });

  it("(d) every @tcb-negative tag names an id present in tcb.json (no orphans)", () => {
    const orphans = tagHits
      .filter((h) => !declaredIds.has(h.id))
      .map((h) => `${h.id} @ ${h.file.slice(REPO_ROOT.length + 1)}`)
      .sort();
    expect(orphans, `orphan @tcb-negative tags (id not in tcb.json): ${orphans.join("; ")}`).toEqual([]);
  });
});
