import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadContract } from "@stele/core";
import type { ViolationReport } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { ExitCode } from "../errors.js";

/**
 * Score command — computes a 0-10 contract health score.
 *
 * Reads CLI-side state files. Does NOT modify any files (read-only).
 * Missing dimensions are skipped; remaining weights are renormalized.
 *
 * Exit codes:
 * - 0: score >= threshold (or no threshold set)
 * - 6: score < threshold (SCORE_BELOW_THRESHOLD)
 */

interface Dimension {
  name: string;
  weight: number;
  evaluate: (ctx: EvalContext) => ScoreCheck | undefined;
}

interface EvalContext {
  projectDir: string;
  invariantCount: number;
  protectedPatterns: number;
  lastCheckReport: ViolationReport | null;
  baselineMtimeMs: number | null;
  cacheExists: boolean;
  manifestExists: boolean;
}

interface ScoreCheck {
  name: string;
  score: number;
  weight: number;
  reason: string;
}

export interface ScoreResult {
  score: number;
  maxScore: number;
  checks: ScoreCheck[];
  summary: string;
}

const DIMENSIONS: Dimension[] = [
  {
    name: "contract-coverage",
    weight: 0.3,
    evaluate: (ctx) => {
      if (ctx.invariantCount === 0 || ctx.protectedPatterns === 0) {
        return undefined;
      }
      const ratio = Math.min(ctx.invariantCount / ctx.protectedPatterns, 1);
      return {
        name: "contract-coverage",
        score: ratio,
        weight: 0.3,
        reason: `${ctx.invariantCount} invariant(s) over ${ctx.protectedPatterns} protected pattern(s) (ratio: ${ratio.toFixed(2)})`,
      };
    },
  },
  {
    name: "last-check-result",
    weight: 0.25,
    evaluate: (ctx) => {
      if (!ctx.lastCheckReport) {
        return undefined;
      }
      return {
        name: "last-check-result",
        score: ctx.lastCheckReport.ok ? 1 : 0,
        weight: 0.25,
        reason: ctx.lastCheckReport.ok ? "last check passed" : "last check failed",
      };
    },
  },
  {
    name: "baseline-freshness",
    weight: 0.2,
    evaluate: (ctx) => {
      if (ctx.baselineMtimeMs === null) {
        return undefined;
      }
      const hours = (Date.now() - ctx.baselineMtimeMs) / 3_600_000;
      const score = Math.max(0, Math.min(1, 1 - hours / 84));
      return {
        name: "baseline-freshness",
        score,
        weight: 0.2,
        reason: `${hours.toFixed(1)}h since last baseline update`,
      };
    },
  },
  {
    name: "generation-cache",
    weight: 0.1,
    evaluate: (ctx) => {
      if (!ctx.cacheExists) {
        return undefined;
      }
      return {
        name: "generation-cache",
        score: 1,
        weight: 0.1,
        reason: "generation cache present",
      };
    },
  },
  {
    name: "manifest-lock",
    weight: 0.15,
    evaluate: (ctx) => {
      if (!ctx.manifestExists) {
        return undefined;
      }
      return {
        name: "manifest-lock",
        score: 1,
        weight: 0.15,
        reason: "manifest file locked",
      };
    },
  },
];

function readLastCheckReport(projectDir: string): ViolationReport | null {
  const path = join(projectDir, "contract", ".last-check-report.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function getBaselineMtime(projectDir: string): number | null {
  const path = join(projectDir, "contract", "baseline.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function hasCache(projectDir: string): boolean {
  return existsSync(join(projectDir, "contract", ".cache", "hash-manifest.json"));
}

function hasManifest(projectDir: string): boolean {
  return existsSync(join(projectDir, "contract", ".manifest.json"));
}

function computeScore(checks: ScoreCheck[]): { score: number; maxScore: number } {
  if (checks.length === 0) {
    return { score: 0, maxScore: 10 };
  }
  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const normalized = checks.map((c) => ({ ...c, weight: c.weight / totalWeight }));
  const rawScore = normalized.reduce((sum, c) => sum + c.score * c.weight, 0);
  const clamped = Math.max(0, Math.min(1, rawScore));
  return { score: Math.round(clamped * 100) / 10, maxScore: 10 };
}

export interface ScoreOptions {
  json?: boolean;
  threshold?: number;
}

export async function runScore(projectDir: string, options: ScoreOptions = {}): Promise<ScoreResult | void> {
  const resolved = resolve(projectDir);
  const config = await loadConfig(resolved);
  const contract = await loadContract(resolve(resolved, config.entry));

  const ctx: EvalContext = {
    projectDir: resolved,
    invariantCount: contract.invariants.length,
    protectedPatterns: config.protected.length,
    lastCheckReport: readLastCheckReport(resolved),
    baselineMtimeMs: getBaselineMtime(resolved),
    cacheExists: hasCache(resolved),
    manifestExists: hasManifest(resolved),
  };

  const checks: ScoreCheck[] = [];
  for (const dim of DIMENSIONS) {
    const result = dim.evaluate(ctx);
    if (result !== undefined) {
      checks.push(result);
    }
  }

  const { score, maxScore } = computeScore(checks);
  const summary = checks.length === 0 ? "no data — run `stele check` first" : `${score.toFixed(1)}/${maxScore}`;
  const result: ScoreResult = { score, maxScore, checks, summary };

  if (options.threshold !== undefined && score < options.threshold) {
    process.exitCode = ExitCode.SCORE_BELOW_THRESHOLD;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(`Score: ${score.toFixed(1)}/${maxScore}\n\n`);
    for (const check of checks) {
      process.stdout.write(`  ${check.name}: ${check.score.toFixed(2)} (${check.reason})\n`);
    }
    if (checks.length === 0) {
      process.stdout.write("  (no dimensions available)\n");
    }
  }

  return result;
}