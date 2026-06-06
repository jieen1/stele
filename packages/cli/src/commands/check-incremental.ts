import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { stableStringCompare } from "@stele/core";
import type { CallGraph } from "@stele/call-graph-core";
import type { PreparedCheckContext } from "../architecture/types.js";
import { pickPhaseLanguage } from "../config/phase-language.js";
import { pickTraceCallGraphExtractor } from "../backend-registry.js";
import { enumerateUniverse } from "../coverage/universe.js";
import { expandContractToFiles, type Mechanism } from "../coverage/expand.js";

const execFileAsync = promisify(execFile);

/**
 * `stele check --changed-from <ref>` / `--changed <file...>` — the inner-loop
 * speedup.
 *
 * The contract is *correctness-preserving*: incremental is a speedup, NOT a
 * semantic change. A file-scoped stage may be skipped ONLY when we can prove no
 * changed source file lies in that stage's covered-file set. Everything that
 * scans the whole repo or depends on the whole contract ALWAYS runs. When the
 * proof is unavailable (no call graph, empty universe, extraction failure,
 * expansion failure), we RUN the stage. There is no path here that turns a
 * would-be violation green.
 *
 * This is the complement of `--diff`/`--diff-from`: those filter *invariants*
 * by changed *contract* files; this skips file-scoped *source-analysis* stages
 * by changed *source* files. They compose without interfering.
 */

/**
 * The only stages eligible for skipping. Each maps a check-stage id to the
 * `expandContractToFiles` mechanisms that drive it. A stage is skippable iff it
 * binds at least one declaration AND none of those declarations' covered files
 * is in the changed set.
 *
 * Everything NOT in this map (generated, protected, design, toolchain,
 * type-driven, plus the Python uses-checker invariants that run under pytest)
 * is GLOBAL and always runs.
 */
const SKIPPABLE_STAGE_MECHANISMS: ReadonlyMap<string, readonly Mechanism[]> = new Map([
  ["code-shape", ["boundary", "type-policy", "file-policy", "function-shape", "class-shape"]],
  ["architecture", ["architecture"]],
  ["complexity", ["core-node"]],
  ["trace", ["trace-policy"]],
  ["type-state", ["type-state"]],
  ["effect", ["effect-policy"]],
]);

export const SKIPPABLE_STAGE_IDS: readonly string[] = [...SKIPPABLE_STAGE_MECHANISMS.keys()];

export interface IncrementalPlan {
  /** True when an incremental flag was supplied (--changed-from or --changed). */
  readonly active: boolean;
  /** Source files reported as changed (project-relative POSIX paths). */
  readonly changedFiles: readonly string[];
  /** Stage ids proven unaffected and therefore skipped. */
  readonly skipped: ReadonlySet<string>;
  /** Human-readable, deterministic explanation lines for the banner/report. */
  readonly notes: readonly string[];
}

export interface IncrementalDeps {
  /** Override the call-graph builder (tests inject a stub or null). */
  buildCallGraph?: (
    projectDir: string,
    language: string,
    tsconfig: string | undefined,
  ) => Promise<CallGraph | null>;
}

export const NO_INCREMENTAL: IncrementalPlan = Object.freeze({
  active: false,
  changedFiles: [],
  skipped: new Set<string>(),
  notes: [],
});

function isOutsideProject(relativePath: string): boolean {
  return relativePath.startsWith("../") || relativePath === ".." || win32.isAbsolute(relativePath);
}

async function runGit(cwd: string, args: string[], errorMessage: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${errorMessage} ${detail}`.trim());
  }
}

/**
 * Collect changed source paths since `ref` (branch diff + unstaged + staged +
 * untracked), mirroring `collectGitDiffScope`'s union so the inner loop sees
 * working-tree edits, not just committed ones. Fail closed: a git error throws
 * so the caller cannot silently skip stages on an empty set.
 */
export async function collectChangedSourceFiles(projectDir: string, ref: string): Promise<string[]> {
  const repoRoot = await runGit(
    projectDir,
    ["rev-parse", "--show-toplevel"],
    `Git is required for --changed-from ${ref}, but no repository root was found.`,
  );
  await runGit(
    repoRoot,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    `Git base "${ref}" was not found. Choose an existing branch, tag, or commit for --changed-from.`,
  );

  const outputs = await Promise.all([
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${ref}...HEAD`], "Unable to compute the branch diff."),
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB"], "Unable to compute unstaged diff scope."),
    runGit(repoRoot, ["diff", "--name-only", "--diff-filter=ACMRTUXB", "--cached"], "Unable to compute staged diff scope."),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], "Unable to list untracked files for diff scope."),
  ]);

  return normalizeChangedPaths(projectDir, repoRoot, outputs);
}

/** Normalize raw `--changed <file...>` values to project-relative POSIX paths. */
export function normalizeChangedArg(projectDir: string, files: readonly string[]): string[] {
  const projectRoot = resolve(projectDir);
  const out = new Set<string>();
  for (const candidate of files) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const absolutePath = resolve(projectRoot, trimmed);
    const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");
    if (relativePath.length > 0 && !isOutsideProject(relativePath)) {
      out.add(relativePath);
    }
  }
  return [...out].sort((a, b) => stableStringCompare(a, b));
}

function normalizeChangedPaths(projectDir: string, repoRoot: string, outputs: readonly string[]): string[] {
  const projectRoot = resolve(projectDir);
  const changed = new Set<string>();
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate.length === 0) continue;
      const absolutePath = resolve(repoRoot, candidate);
      const relativePath = relative(projectRoot, absolutePath).replaceAll("\\", "/");
      if (relativePath.length === 0 || isOutsideProject(relativePath)) continue;
      changed.add(relativePath);
    }
  }
  return [...changed].sort((a, b) => stableStringCompare(a, b));
}

function resolveTsconfigPath(projectDir: string, configTsconfig: string | undefined): string | null {
  const candidate = configTsconfig
    ? resolve(projectDir, configTsconfig)
    : resolve(projectDir, "tsconfig.json");
  return existsSync(candidate) ? candidate : null;
}

async function defaultBuildCallGraph(
  projectDir: string,
  language: string,
  tsconfig: string | undefined,
): Promise<CallGraph | null> {
  const extractor = pickTraceCallGraphExtractor(language);
  if (extractor === null) return null;
  const tsconfigPath = language === "typescript" ? resolveTsconfigPath(projectDir, tsconfig) : null;
  if (language === "typescript" && tsconfigPath === null) return null;
  return extractor.extract({
    projectRoot: projectDir,
    tsconfigPath: tsconfigPath ?? undefined,
    cacheDir: resolve(projectDir, "contract/.cache"),
  });
}

/**
 * Compute which file-scoped stages are provably unaffected by `changedFiles`.
 *
 * Safety: a stage is added to `skipped` ONLY when the reverse index proved it
 * binds files AND none of those files changed. Any uncertainty (extraction
 * failure, missing call graph for a symbol mechanism, expansion failure on a
 * declaration) keeps the stage running. Global stages are never considered.
 */
export async function computeIncrementalPlan(
  context: PreparedCheckContext,
  changedFiles: readonly string[],
  deps: IncrementalDeps = {},
): Promise<IncrementalPlan> {
  const projectDir = resolve(context.projectDir);
  const contract = context.contract;
  const changedSet = new Set(changedFiles);
  const notes: string[] = [];

  const universe = await enumerateUniverse(projectDir);
  const universePaths = universe.map((f) => f.path);

  const language = pickPhaseLanguage(context.config, "trace");
  const buildCallGraph = deps.buildCallGraph ?? defaultBuildCallGraph;
  let callGraph: CallGraph | null = null;
  let callGraphFailed = false;
  try {
    callGraph = await buildCallGraph(projectDir, language, context.config.tsconfig);
  } catch {
    callGraph = null;
    callGraphFailed = true;
  }

  const expansion = await expandContractToFiles({
    contract,
    projectDir,
    callGraph: callGraph ?? undefined,
    universeFiles: universePaths,
  });

  // Declarations that failed to expand cannot be proven safe-to-skip; force
  // their owning mechanisms to run.
  const failedMechanisms = new Set<Mechanism>();
  if (expansion.failures.length > 0) {
    // We cannot map a failure id back to a mechanism cheaply, so be maximally
    // conservative: any expansion failure forces ALL file-scoped stages to run.
    for (const m of SKIPPABLE_STAGE_MECHANISMS.values()) {
      for (const mech of m) failedMechanisms.add(mech);
    }
    notes.push(
      `incremental: ${expansion.failures.length} declaration(s) failed to expand; running all file-scoped stages to stay correct.`,
    );
  }

  // Symbol mechanisms need a call graph to be proven safe-to-skip. Without one
  // (or after an extraction failure) their declarations bind no files in the
  // reverse index, which would make them *look* skippable — that is a false
  // green. Force them to run.
  const symbolMechanisms: readonly Mechanism[] = ["trace-policy", "effect-policy", "type-state"];
  const callGraphUnavailable = callGraph === null;
  const symbolMechanismsUnsafe = new Set<Mechanism>();
  if (callGraphUnavailable) {
    for (const mech of symbolMechanisms) symbolMechanismsUnsafe.add(mech);
    if (callGraphFailed) {
      notes.push("incremental: call-graph extraction failed; running trace/effect/type-state to stay correct.");
    } else {
      notes.push(
        `incremental: no call-graph extractor for targetLanguage="${language}"; running trace/effect/type-state to stay correct.`,
      );
    }
  }

  // Build the per-mechanism covered-file set from the reverse index.
  const mechanismFiles = new Map<Mechanism, Set<string>>();
  // A *bound* declaration that covers ZERO files is not "binds nothing" — it is
  // a declaration whose coverage we cannot express as a file set: a whole-graph
  // trace policy (empty `scope` ⇒ guards every caller) or an extern-only target.
  // Its true coverage is unbounded, so NO change can be proven disjoint from it.
  // Force its stage to run — treating it as skippable would be a false green.
  const mechanismUnboundedCoverage = new Set<Mechanism>();
  for (const decl of expansion.declarations.values()) {
    let set = mechanismFiles.get(decl.mechanism);
    if (set === undefined) {
      set = new Set<string>();
      mechanismFiles.set(decl.mechanism, set);
    }
    for (const f of decl.files) set.add(f);
    if (decl.bound && decl.files.size === 0) {
      mechanismUnboundedCoverage.add(decl.mechanism);
    }
  }

  const skipped = new Set<string>();
  for (const [stageId, mechanisms] of SKIPPABLE_STAGE_MECHANISMS) {
    let canSkip = true;
    let bindsAnything = false;
    let forcedReason: string | undefined;

    for (const mech of mechanisms) {
      if (failedMechanisms.has(mech) || symbolMechanismsUnsafe.has(mech)) {
        canSkip = false;
        forcedReason = "uncertain binding";
        break;
      }
      if (mechanismUnboundedCoverage.has(mech)) {
        canSkip = false;
        bindsAnything = true;
        forcedReason = "unbounded coverage";
        notes.push(
          `incremental: stage "${stageId}" runs — a ${mech} declaration has whole-graph/extern-only scope (coverage cannot be proven disjoint from any change).`,
        );
        break;
      }
      const files = mechanismFiles.get(mech);
      if (files === undefined || files.size === 0) continue;
      bindsAnything = true;
      for (const f of files) {
        if (changedSet.has(f)) {
          canSkip = false;
          break;
        }
      }
      if (!canSkip) break;
    }

    if (forcedReason !== undefined) {
      // Already noted globally above; stage simply runs.
      continue;
    }

    if (!bindsAnything) {
      // No declaration binds any file for this stage. The stage's own
      // `shouldRun` gate (empty contract collection) will already no-op it, so
      // there is nothing to skip and nothing at risk. Leave it to shouldRun.
      continue;
    }

    if (canSkip) {
      skipped.add(stageId);
      notes.push(`incremental: stage "${stageId}" skipped — no changed file is in its scope.`);
    } else {
      notes.push(`incremental: stage "${stageId}" runs — a changed file is in its scope.`);
    }
  }

  notes.sort((a, b) => stableStringCompare(a, b));

  return {
    active: true,
    changedFiles: [...changedFiles],
    skipped,
    notes,
  };
}
