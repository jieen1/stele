import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Language-dispatched teeth runners. The teeth gate runs ONE self-contained
 * candidate negative test against a revision's own source inside an isolated
 * git worktree, and derives the verdict purely from the test's exit code. That
 * model fits any language whose test can run against the worktree's checked-out
 * source without a separate, project-specific build/install step:
 *
 *   - python      → `python -m pytest <file>`        (interpreted; src on PYTHONPATH)
 *   - javascript  → `node --test <file>`             (interpreted; same node as the CLI)
 *   - typescript  → `node --test --experimental-strip-types <file>`
 *   - rust        → `cargo test --test <stem>`       (crate compiles from the worktree)
 *
 * Go and Java are intentionally NOT wired: a single root-level test file cannot
 * soundly exercise project code under `go test` (package-placement) or a JUnit
 * runner (classpath/compile) without a package/build-aware design. They are
 * rejected loudly at draft/validation time rather than shipped as a hollow
 * runner that would only ever return TEETH_FAILED.
 *
 * A toolchain that is recognized but ABSENT at run time raises an INFRA error
 * (the caller maps it to exit 1) — never a TEETH_FAILED verdict, so a missing
 * interpreter can never masquerade as a toothless test.
 */

export type TeethLanguage = "python" | "javascript" | "typescript" | "rust" | "go";

export interface ResolvedToolchain {
  /** Executable to spawn (absolute path or PATH-resolved name). */
  readonly bin: string;
}

export interface TeethRunCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * How a NON-zero-exit run failed. The teeth gate keys TEETH_PROVEN on the
 * PARENT run's class: a real `assertion` failure proves the test's assertion
 * catches the regression; a `collection-or-build` error means the test never
 * executed its assertions at <fix>^ (e.g. it imports a fix-only symbol), so it
 * does NOT demonstrate teeth and must not be PROVEN. `unknown` (output we can't
 * classify) conservatively falls back to the exit-code rule — we never invent a
 * TEETH_FAILED from classifier uncertainty. `passed` is a zero-exit run.
 */
export type BiteClass = "assertion" | "collection-or-build" | "unknown" | "passed";

export interface TeethRunner {
  readonly language: TeethLanguage;
  /** Relative path, within the worktree, where the candidate test is written. */
  placement(basename: string): string;
  /**
   * Resolve the toolchain binary; throw an INFRA Error (mapped to exit 1) when
   * it is absent. `override` is the injected test seam (only python uses it).
   */
  locate(projectDir: string, override?: string): ResolvedToolchain;
  /** Build the run command for the placed test inside `worktreeDir`. */
  buildRun(tc: ResolvedToolchain, placedRel: string, worktreeDir: string): TeethRunCommand;
  /**
   * Classify a NON-zero-exit run's normalized output. MUST be high-precision for
   * `collection-or-build` (only clear import/compile/collection errors) — a real
   * assertion failure misclassified as build error would wrongly reject a valid
   * proof. Anything ambiguous → `unknown` (the safe fallback).
   */
  classifyFailure(normalizedOutput: string): BiteClass;
}

// ---------------------------------------------------------------------------
// Filename ↔ language
// ---------------------------------------------------------------------------

const EXTENSION_LANGUAGE: ReadonlyArray<[RegExp, TeethLanguage]> = [
  [/\.py$/, "python"],
  [/\.(?:mts|cts|ts)$/, "typescript"],
  [/\.(?:mjs|cjs|js)$/, "javascript"],
  [/\.rs$/, "rust"],
  [/\.go$/, "go"],
];

/** Languages a candidate test may be authored in, for user-facing messages. */
export const SUPPORTED_TEST_EXTENSIONS = ".py, .ts, .mts, .cts, .js, .mjs, .cjs, .rs, .go (must be *_test.go)";

/** The runnable extension a candidate test must end with (path-safety aside). */
const SAFE_BASENAME_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:py|mts|cts|ts|mjs|cjs|js|rs|go)$/;

export function inferTeethLanguage(basename: string): TeethLanguage | null {
  for (const [pattern, language] of EXTENSION_LANGUAGE) {
    if (pattern.test(basename)) {
      return language;
    }
  }
  return null;
}

/**
 * Path-safety + supported-extension gate for the candidate test filename (the
 * bytes are agent-supplied). The basename must be bare (no separators, not
 * absolute) AND end in a runnable extension. Go/Java/unknown extensions are
 * rejected here with a message naming the supported set, so a dead-end draft is
 * never written. Throws on any violation; returns the validated basename.
 */
export function assertSafeTestBasename(name: string): string {
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(
      `Unsafe testFilename ${JSON.stringify(name)}: must be a bare filename with no path separators.`,
    );
  }
  if (!SAFE_BASENAME_PATTERN.test(name)) {
    if (/\.java$/.test(name)) {
      throw new Error(
        `testFilename ${JSON.stringify(name)}: Java is not yet supported by the teeth gate ` +
          `(it needs a build-tool-aware runner). Author the negative test in one of: ` +
          `${SUPPORTED_TEST_EXTENSIONS}, or record TEETH_UNAVAILABLE via ` +
          `\`approve --teeth-unavailable-reason\`.`,
      );
    }
    throw new Error(
      `Unsafe or unsupported testFilename ${JSON.stringify(name)}: must be a bare filename ` +
        `ending in one of ${SUPPORTED_TEST_EXTENSIONS}.`,
    );
  }
  // Rust: `cargo test --test <stem>` treats the stem as a crate name, which
  // forbids `.`/`-`. Reject up-front with a clear message instead of letting
  // cargo emit an opaque "invalid character in crate name" error mid-run.
  if (name.endsWith(".rs") && !/^[A-Za-z0-9_]+\.rs$/.test(name)) {
    throw new Error(
      `testFilename ${JSON.stringify(name)}: a Rust test stem becomes a cargo --test target ` +
        `(a crate name), so it may contain only [A-Za-z0-9_] before ".rs" (no "." or "-").`,
    );
  }
  // Go: `go test` only picks up files named `*_test.go`. Reject up-front so a
  // mis-named Go file isn't silently ignored (→ a vacuous "ok" at both revs).
  if (name.endsWith(".go") && !name.endsWith("_test.go")) {
    throw new Error(
      `testFilename ${JSON.stringify(name)}: a Go teeth test must be named \`*_test.go\` ` +
        `(go test ignores other files).`,
    );
  }
  return name;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function binaryOnPath(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const pythonRunner: TeethRunner = {
  language: "python",
  placement: (basename) => basename,
  locate(projectDir, override) {
    if (override && override.trim().length > 0) {
      return { bin: override.trim() };
    }
    const venvPython = join(projectDir, ".venv", "bin", "python");
    if (existsSync(venvPython)) {
      return { bin: venvPython };
    }
    if (binaryOnPath("python")) {
      return { bin: "python" };
    }
    if (binaryOnPath("python3")) {
      return { bin: "python3" };
    }
    throw new Error(
      "No python interpreter found (.venv/bin/python, python, python3 all absent); cannot run teeth.",
    );
  },
  buildRun(tc, placedRel, worktreeDir) {
    const inherited = process.env.PYTHONPATH;
    const pythonPath = inherited ? `${worktreeDir}${delimiter}${inherited}` : worktreeDir;
    return {
      cmd: tc.bin,
      // --noconftest: the candidate is a single self-contained file and must NOT
      // load an ancestor conftest.py. --rootdir pins discovery to the worktree;
      // -p no:cacheprovider keeps a .pytest_cache out of it.
      args: [
        "-m",
        "pytest",
        placedRel,
        "-q",
        "--noconftest",
        "-p",
        "no:cacheprovider",
        `--rootdir=${worktreeDir}`,
      ],
      env: { ...process.env, PYTHONPATH: pythonPath },
    };
  },
  classifyFailure(out) {
    // Precise per-test failure markers ONLY. pytest emits "N failed"/"FAILED <id>"
    // exclusively when a test actually RAN and failed (a collection error shows
    // "N error", never "N failed"). A bare "AssertionError" is deliberately NOT
    // here: an import-time AssertionError surfaces inside a COLLECTION error, and
    // treating that as 'assertion' would re-open the false-green B2 closes.
    if (/\b\d+ failed\b/.test(out) || /\bFAILED\b/.test(out)) {
      return "assertion";
    }
    // High-precision collection/import/syntax errors: the test never ran.
    if (
      /errors? during collection/i.test(out) ||
      /\bERROR collecting\b/.test(out) ||
      /\b\d+ error(?:s)?\b/.test(out) ||
      /\b(?:ModuleNotFoundError|ImportError|SyntaxError|IndentationError)\b/.test(out)
    ) {
      return "collection-or-build";
    }
    return "unknown";
  },
};

function nodeRunner(language: "javascript" | "typescript"): TeethRunner {
  return {
    language,
    placement: (basename) => basename,
    locate() {
      // The same Node that runs the CLI — always present, no project deps needed.
      return { bin: process.execPath };
    },
    buildRun(tc, placedRel) {
      const stripTypes = language === "typescript" ? ["--experimental-strip-types"] : [];
      return {
        cmd: tc.bin,
        // --no-warnings keeps the ExperimentalWarning (strip-types) out of the
        // hashed output. The node test runner exits non-zero iff a test fails.
        args: ["--no-warnings", ...stripTypes, "--test", placedRel],
        env: { ...process.env },
      };
    },
    classifyFailure(out) {
      // PRECISE assertion markers FIRST. node:test emits `AssertionError` /
      // `code: 'ERR_ASSERTION'` ONLY for a genuine assertion failure; a load
      // failure (wrapped as a failing test) emits `ERR_TEST_FAILURE`, never
      // ERR_ASSERTION. Checking these first stops an assertion whose echoed value
      // contains "SyntaxError"/"Cannot find module" from being misread as a build
      // error (the false-reject the runner's own contract warns against).
      if (/\bAssertionError\b/.test(out) || /ERR_ASSERTION/.test(out)) {
        return "assertion";
      }
      // Load/import/syntax errors: the file never ran its assertions. (Reached
      // only when there was no real assertion failure above.)
      if (
        /ERR_MODULE_NOT_FOUND/.test(out) ||
        /Cannot find (?:module|package)/.test(out) ||
        /ERR_UNKNOWN_FILE_EXTENSION/.test(out) ||
        /\bSyntaxError\b/.test(out)
      ) {
        return "collection-or-build";
      }
      // A test ran and failed for a non-assertion reason (threw) with no build marker.
      if (/\bnot ok\b/.test(out) || /# fail [1-9]/.test(out)) {
        return "assertion";
      }
      return "unknown";
    },
  };
}

const rustRunner: TeethRunner = {
  language: "rust",
  // cargo integration tests live in <crate>/tests/<name>.rs.
  placement: (basename) => join("tests", basename),
  locate() {
    if (binaryOnPath("cargo")) {
      return { bin: "cargo" };
    }
    throw new Error("cargo not found on PATH; cannot run a Rust teeth proof.");
  },
  buildRun(tc, placedRel, worktreeDir) {
    // `cargo test --test <stem>` selects the integration test by file stem.
    const stem = placedRel.replace(/^tests[\\/]/, "").replace(/\.rs$/, "");
    return {
      cmd: tc.bin,
      args: ["test", "--test", stem, "--quiet"],
      // Force a per-worktree target dir: an inherited absolute CARGO_TARGET_DIR
      // (common in CI caches) would make the parent and fix worktrees compile
      // into the SAME dir — identical package name + relative paths means cargo
      // reuses the parent's stale binary for the fix run, silently collapsing a
      // real fix to TEETH_FAILED. Pinning it per worktree keeps the two runs
      // independent.
      env: { ...process.env, CARGO_TARGET_DIR: join(worktreeDir, "target") },
    };
  },
  classifyFailure(out) {
    // Run-only markers FIRST: cargo prints `test result: FAILED` / a panic banner
    // ONLY after the binary built and ran; a genuine compile failure prints
    // neither. Checking these first stops an assertion/panic whose message echoes
    // "error[E…]"/"could not compile" from being misread as a build error.
    if (/test result: FAILED/.test(out) || /assertion .*failed/.test(out) || /\bpanicked\b/.test(out)) {
      return "assertion";
    }
    // Compile errors: the test binary never built, so no assertion ran.
    if (/could not compile/.test(out) || /\berror\[E\d+\]/.test(out)) {
      return "collection-or-build";
    }
    return "unknown";
  },
};

/** Isolated package dir (within the worktree) the Go candidate test is placed in. */
const GO_PROBE_DIR = "stele_teeth_probe";

const goRunner: TeethRunner = {
  language: "go",
  // Place the candidate in its OWN fresh package dir so `go test ./<dir>/` runs
  // ONLY this test (no conflation with the project's existing _test.go files).
  // The candidate is a self-contained test that imports the project package by
  // its module path; the worktree's committed go.mod provides module resolution.
  placement: (basename) => join(GO_PROBE_DIR, basename),
  locate() {
    const explicit = process.env.STELE_GO;
    if (explicit && explicit.trim().length > 0) {
      return { bin: explicit.trim() };
    }
    if (binaryOnPath("go")) {
      return { bin: "go" };
    }
    throw new Error("go not found on PATH (set STELE_GO); cannot run a Go teeth proof.");
  },
  buildRun(tc) {
    return {
      cmd: tc.bin,
      args: ["test", `./${GO_PROBE_DIR}/`],
      // GOTOOLCHAIN=local: never auto-download a toolchain for the probe.
      env: { ...process.env, GOTOOLCHAIN: "local" },
    };
  },
  classifyFailure(out) {
    // Run-only markers FIRST: `--- FAIL` / `panic:` appear only after the test
    // binary built and ran. A genuine build failure prints `[build failed]` /
    // `cannot find` / `undefined:` but no `--- FAIL`, so an assertion whose
    // message echoes a build token is not misread as a build error.
    if (/--- FAIL/.test(out) || /\bpanic:/.test(out)) {
      return "assertion";
    }
    if (
      /\[build failed\]/.test(out) ||
      /build constraints exclude all Go files/.test(out) ||
      /no(?:\srequired module provides| Go files)/.test(out) ||
      /cannot find (?:module|package)/.test(out) ||
      /\bundefined:/.test(out)
    ) {
      return "collection-or-build";
    }
    return "unknown";
  },
};

const RUNNERS: Record<TeethLanguage, TeethRunner> = {
  python: pythonRunner,
  javascript: nodeRunner("javascript"),
  typescript: nodeRunner("typescript"),
  rust: rustRunner,
  go: goRunner,
};

/**
 * Resolve the runner for a (already path-safe) candidate test basename. Throws
 * an INFRA Error for an unsupported/unknown extension so the caller maps it to
 * exit 1 rather than a verdict.
 */
export function resolveTeethRunner(basename: string): TeethRunner {
  const language = inferTeethLanguage(basename);
  if (language === null) {
    throw new Error(
      `No teeth runner for ${JSON.stringify(basename)}: supported extensions are ${SUPPORTED_TEST_EXTENSIONS}.`,
    );
  }
  return RUNNERS[language];
}
