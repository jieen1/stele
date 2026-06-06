import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadContract, stableStringCompare, uniqueSortedStrings } from "@stele/core";
import type { CallGraph } from "@stele/call-graph-core";
import { loadConfig } from "../config/loadConfig.js";
import { pickPhaseLanguage } from "../config/phase-language.js";
import { pickTraceCallGraphExtractor } from "../backend-registry.js";
import { CliCommandError, ExitCode } from "../errors.js";
import { enumerateUniverse } from "../coverage/universe.js";
import {
  expandContractToFiles,
  type ExpandedDeclaration,
  type Mechanism,
} from "../coverage/expand.js";
import { gitChurn, type GetChurn } from "../coverage/churn.js";

const ALL_MECHANISMS: readonly Mechanism[] = [
  "boundary",
  "type-policy",
  "file-policy",
  "function-shape",
  "class-shape",
  "trace-policy",
  "effect-policy",
  "type-state",
  "architecture",
  "core-node",
  "branded-id",
];

export interface CoverageOptions {
  json?: boolean;
  min?: number;
  top?: number;
  since?: string;
  by?: "file" | "package" | "mechanism";
}

interface CoverageHit {
  mechanism: Mechanism;
  declarationId: string;
  symbol?: string;
}

interface FileCoverage {
  path: string;
  pkg: string;
  covered: boolean;
  churn: number;
  lastTouched?: string;
  hits: CoverageHit[];
  architecturallyUnowned?: boolean;
}

interface PackageRollup {
  pkg: string;
  total: number;
  covered: number;
  ratio: number;
  uncovered: string[];
}

interface Hotspot {
  path: string;
  pkg: string;
  churn: number;
  lastTouched?: string;
  reason: "uncovered";
}

interface MechanismRollup {
  declarationCount: number;
  filesTouched: number;
  support?: "supported" | "unsupported";
}

export interface CoverageReport {
  schemaVersion: "1";
  git: { commit: string | null; since: string | null };
  totals: { total: number; covered: number; ratio: number };
  byPackage: PackageRollup[];
  byMechanism: Record<Mechanism, MechanismRollup>;
  files: FileCoverage[];
  hotspots: Hotspot[];
  nonSpatialGuards: { checkers: number; invariantsUsingCheckers: number };
  mechanismExpansionFailures: Array<{ declarationId: string; reason: string }>;
  externTargets: string[];
  notes: string[];
  thresholds?: { min: number; met: boolean };
}

interface CoverageDeps {
  getChurn?: GetChurn;
  /** Override the call-graph builder (tests inject a stub or null). */
  buildCallGraph?: (
    projectDir: string,
    language: string,
    tsconfig: string | undefined,
  ) => Promise<CallGraph | null>;
}

const SYMBOL_MECHANISMS: ReadonlySet<Mechanism> = new Set(["trace-policy", "effect-policy", "type-state"]);

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

export async function buildCoverageReport(
  projectDir: string,
  options: CoverageOptions = {},
  deps: CoverageDeps = {},
): Promise<CoverageReport> {
  const resolved = resolve(projectDir);

  let config;
  try {
    config = await loadConfig(resolved);
  } catch (error) {
    throw new CliCommandError(
      `Unable to load stele.config.json: ${error instanceof Error ? error.message : String(error)}`,
      ExitCode.CONFIG_ERROR,
    );
  }

  let contract;
  try {
    contract = await loadContract(resolve(resolved, config.entry));
  } catch (error) {
    throw new CliCommandError(
      `Unable to load contract: ${error instanceof Error ? error.message : String(error)}`,
      ExitCode.CONFIG_ERROR,
    );
  }

  const universe = await enumerateUniverse(resolved);
  const universePaths = universe.map((f) => f.path);
  const universeSet = new Set(universePaths);

  const language = pickPhaseLanguage(config, "trace");
  const buildCallGraph = deps.buildCallGraph ?? defaultBuildCallGraph;
  let callGraph: CallGraph | null = null;
  const notes: string[] = [];
  try {
    callGraph = await buildCallGraph(resolved, language, config.tsconfig);
  } catch (error) {
    notes.push(
      `Call graph extraction failed (${error instanceof Error ? error.message : String(error)}); symbol mechanisms (trace/effect/type-state) report 0 coverage.`,
    );
    callGraph = null;
  }

  const hasSymbolDecls =
    contract.tracePolicies.length > 0 || contract.effectPolicies.length > 0 || contract.typeStates.length > 0;
  if (callGraph === null && hasSymbolDecls) {
    notes.push(
      `No call-graph extractor available for targetLanguage="${language}"; trace/effect/type-state mechanisms report support=unsupported and contribute 0 file coverage.`,
    );
  }

  const expansion = await expandContractToFiles({
    contract,
    projectDir: resolved,
    callGraph: callGraph ?? undefined,
    universeFiles: universePaths,
  });

  // Init every universe file as uncovered, then apply deduped hits.
  const fileMap = new Map<string, FileCoverage>();
  for (const f of universe) {
    fileMap.set(f.path, { path: f.path, pkg: f.pkg, covered: false, churn: 0, hits: [] });
  }

  const seenHitKeys = new Map<string, Set<string>>();
  const mechanismRollup = initMechanismRollup();
  const mechanismFilesTouched = new Map<Mechanism, Set<string>>();

  for (const decl of expansion.declarations.values()) {
    mechanismRollup[decl.mechanism].declarationCount += 1;
    if (!decl.bound) continue;
    applyDeclaration(decl, fileMap, universeSet, seenHitKeys, mechanismFilesTouched);
  }

  for (const m of ALL_MECHANISMS) {
    mechanismRollup[m].filesTouched = mechanismFilesTouched.get(m)?.size ?? 0;
    if (SYMBOL_MECHANISMS.has(m)) {
      mechanismRollup[m].support = callGraph === null ? "unsupported" : "supported";
    }
  }

  // Churn join.
  const getChurn = deps.getChurn ?? gitChurn;
  const since = options.since ?? null;
  const churn = await getChurn(resolved, universePaths, since);
  for (const file of fileMap.values()) {
    const entry = churn.get(file.path);
    if (entry !== undefined) {
      file.churn = entry.commits;
      if (entry.lastTouched !== undefined) file.lastTouched = entry.lastTouched;
    }
  }

  const files = [...fileMap.values()].sort((a, b) => stableStringCompare(a.path, b.path));
  for (const f of files) {
    f.covered = f.hits.length > 0;
    f.hits.sort(
      (a, b) =>
        stableStringCompare(a.mechanism, b.mechanism) || stableStringCompare(a.declarationId, b.declarationId),
    );
  }

  const total = files.length;
  const covered = files.filter((f) => f.covered).length;
  const totals = { total, covered, ratio: total === 0 ? 0 : covered / total };

  const byPackage = rollupByPackage(files);

  const top = options.top ?? 10;
  const hotspots: Hotspot[] = files
    .filter((f) => !f.covered && f.churn > 0)
    .sort((a, b) => b.churn - a.churn || stableStringCompare(a.path, b.path))
    .slice(0, top)
    .map((f) => ({ path: f.path, pkg: f.pkg, churn: f.churn, lastTouched: f.lastTouched, reason: "uncovered" as const }));

  const invariantsUsingCheckers = contract.invariants.filter((inv) => inv.usesChecker !== undefined).length;

  notes.push(
    "Python checkers and uses-checker invariants have no spatial expansion; they are counted as nonSpatialGuards and do not mark files covered.",
  );
  notes.push(
    `Spatial coverage is measured over ${language} source under the configured roots only. Files in other languages (e.g. hand-written .js hook scripts, .py glue) and manifest-protected protection-infrastructure are OUTSIDE this denominator — they may be protected by manifest tamper-evidence and their own tests, not by spatial contracts. A high % here does not imply those surfaces are protected.`,
  );
  if (expansion.externTargets.length > 0) {
    notes.push(`${expansion.externTargets.length} extern: target(s) contribute no file coverage (metadata only).`);
  }

  const report: CoverageReport = {
    schemaVersion: "1",
    git: { commit: await resolveHeadCommit(resolved), since },
    totals,
    byPackage,
    byMechanism: mechanismRollup,
    files,
    hotspots,
    nonSpatialGuards: { checkers: contract.checkers.length, invariantsUsingCheckers },
    mechanismExpansionFailures: [...expansion.failures].sort((a, b) =>
      stableStringCompare(a.declarationId, b.declarationId),
    ),
    externTargets: [...expansion.externTargets],
    notes,
  };

  if (options.min !== undefined) {
    report.thresholds = { min: options.min, met: totals.ratio * 100 >= options.min };
  }

  return report;
}

function applyDeclaration(
  decl: ExpandedDeclaration,
  fileMap: Map<string, FileCoverage>,
  universeSet: Set<string>,
  seenHitKeys: Map<string, Set<string>>,
  mechanismFilesTouched: Map<Mechanism, Set<string>>,
): void {
  let touched = mechanismFilesTouched.get(decl.mechanism);
  if (touched === undefined) {
    touched = new Set<string>();
    mechanismFilesTouched.set(decl.mechanism, touched);
  }
  const hitKey = `${decl.mechanism}::${decl.declarationId}`;
  for (const filePath of decl.files) {
    const file = fileMap.get(filePath);
    if (file === undefined) continue; // outside the countable universe
    if (!universeSet.has(filePath)) continue;
    touched.add(filePath);
    let seen = seenHitKeys.get(filePath);
    if (seen === undefined) {
      seen = new Set<string>();
      seenHitKeys.set(filePath, seen);
    }
    if (seen.has(hitKey)) continue;
    seen.add(hitKey);
    const symbol = [...decl.symbols][0];
    file.hits.push({ mechanism: decl.mechanism, declarationId: decl.declarationId, symbol });
  }
  if (decl.architecturallyUnowned !== undefined) {
    for (const filePath of decl.architecturallyUnowned) {
      const file = fileMap.get(filePath);
      if (file !== undefined) file.architecturallyUnowned = true;
    }
  }
}

function rollupByPackage(files: FileCoverage[]): PackageRollup[] {
  const groups = new Map<string, FileCoverage[]>();
  for (const f of files) {
    const list = groups.get(f.pkg);
    if (list === undefined) groups.set(f.pkg, [f]);
    else list.push(f);
  }
  const out: PackageRollup[] = [];
  for (const [pkg, list] of groups) {
    const total = list.length;
    const covered = list.filter((f) => f.covered).length;
    out.push({
      pkg,
      total,
      covered,
      ratio: total === 0 ? 0 : covered / total,
      uncovered: uniqueSortedStrings(list.filter((f) => !f.covered).map((f) => f.path)),
    });
  }
  out.sort((a, b) => stableStringCompare(a.pkg, b.pkg));
  return out;
}

function initMechanismRollup(): Record<Mechanism, MechanismRollup> {
  const out = {} as Record<Mechanism, MechanismRollup>;
  for (const m of ALL_MECHANISMS) {
    out[m] = { declarationCount: 0, filesTouched: 0 };
  }
  return out;
}

async function resolveHeadCommit(projectDir: string): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: projectDir });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function formatHuman(report: CoverageReport): string {
  const lines: string[] = [];
  const pct = (report.totals.ratio * 100).toFixed(1);
  lines.push(`Contract coverage: ${pct}% (${report.totals.covered}/${report.totals.total})`);
  lines.push("");

  if (report.hotspots.length > 0) {
    lines.push(`${report.hotspots.length} most-changed modules have zero contract coverage:`);
    for (const h of report.hotspots) {
      lines.push(`  ${h.churn.toString().padStart(4)}  ${h.path}`);
    }
  } else {
    lines.push("Every changed module is covered by at least one contract mechanism.");
  }
  lines.push("");

  let lowest: PackageRollup | undefined;
  for (const p of report.byPackage) {
    if (lowest === undefined || p.ratio < lowest.ratio) lowest = p;
  }
  lines.push("Per-package coverage:");
  for (const p of report.byPackage) {
    const marker = p === lowest ? "  ← lowest" : "";
    const ppct = (p.ratio * 100).toFixed(0);
    lines.push(`  ${p.pkg || "(root)"}: ${ppct}% (${p.covered}/${p.total})${marker}`);
  }
  lines.push("");

  for (const note of report.notes) {
    lines.push(`note: ${note}`);
  }

  return lines.join("\n") + "\n";
}

export async function runCoverage(
  projectDir: string,
  options: CoverageOptions = {},
  deps: CoverageDeps = {},
): Promise<CoverageReport> {
  const report = await buildCoverageReport(projectDir, options, deps);

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatHuman(report));
  }

  if (report.thresholds !== undefined && !report.thresholds.met) {
    const pct = (report.totals.ratio * 100).toFixed(1);
    throw new CliCommandError(
      `coverage ${pct}% is below --min ${report.thresholds.min} (exit 2)`,
      ExitCode.CONTRACT_FAIL,
    );
  }

  return report;
}
