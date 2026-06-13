import type { ViolationReport } from "@stele/core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { applyFiltersToReport, type ReportFilters } from "../report/filters.js";
import type { CheckCommandOptions } from "./check.js";
import {
  buildArchitectureStage,
  buildCodeShapeStageReport,
  buildComplexityStage,
  buildDesignStage,
  buildGeneratedStageReport,
} from "./check-stages-other.js";
import { buildProtectedStageReport } from "./check-stages-protected.js";
import { buildToolchainStage } from "./check-stages-toolchain.js";
import { buildEffectStage } from "./check-stages-effect.js";
import { buildTraceStage } from "./check-stages-trace.js";
import { buildTypeDrivenStage } from "./check-stages-type-driven.js";
import { buildTypeStateStage } from "./check-stages-type-state.js";

export interface CheckStage {
  /** Stable identifier (used in REQUIRED_STAGE_IDS test and rule_id namespaces) */
  id: string;
  /** Human description for documentation */
  description: string;
  /** Stages that must run before this one (true dependency, not just ordering preference) */
  dependsOn?: readonly string[];
  /** Whether this stage runs for the given context/options */
  shouldRun(context: PreparedCheckContext, options: CheckCommandOptions): boolean;
  /** Build the stage's ViolationReport */
  build(
    context: PreparedCheckContext,
    protectedState: ProtectedCheckState,
    command: string,
  ): Promise<ViolationReport> | ViolationReport;
}

/**
 * Topologically sort stages by `dependsOn` while preserving declaration order
 * for siblings (Kahn's algorithm with a stable tiebreaker on input index).
 *
 * Throws on cycles, listing the involved node ids.
 */
export function topologicalSortStages(stages: readonly CheckStage[]): CheckStage[] {
  const idToIndex = new Map<string, number>();
  stages.forEach((stage, index) => {
    idToIndex.set(stage.id, index);
  });

  const remainingDeps = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const stage of stages) {
    const deps = new Set<string>();
    for (const dep of stage.dependsOn ?? []) {
      if (idToIndex.has(dep)) {
        deps.add(dep);
        const list = dependents.get(dep) ?? [];
        list.push(stage.id);
        dependents.set(dep, list);
      }
    }
    remainingDeps.set(stage.id, deps);
  }

  const ready: string[] = [];
  for (const stage of stages) {
    if ((remainingDeps.get(stage.id)?.size ?? 0) === 0) {
      ready.push(stage.id);
    }
  }
  ready.sort((a, b) => (idToIndex.get(a) ?? 0) - (idToIndex.get(b) ?? 0));

  const ordered: CheckStage[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const idx = idToIndex.get(id);
    if (idx !== undefined) {
      ordered.push(stages[idx] as CheckStage);
    }
    for (const dependent of dependents.get(id) ?? []) {
      const deps = remainingDeps.get(dependent);
      if (deps === undefined) continue;
      deps.delete(id);
      if (deps.size === 0) {
        // insert dependent in declaration-order position
        const dependentIdx = idToIndex.get(dependent) ?? 0;
        let insertAt = ready.length;
        for (let i = 0; i < ready.length; i++) {
          const candidate = ready[i] as string;
          if ((idToIndex.get(candidate) ?? 0) > dependentIdx) {
            insertAt = i;
            break;
          }
        }
        ready.splice(insertAt, 0, dependent);
      }
    }
  }

  if (ordered.length !== stages.length) {
    const remaining: string[] = [];
    for (const [id, deps] of remainingDeps) {
      if (deps.size > 0) remaining.push(id);
    }
    remaining.sort();
    throw new Error(
      `topologicalSortStages: cycle detected among stages [${remaining.join(", ")}]`,
    );
  }

  return ordered;
}

/**
 * Run all enabled stages in topological order and return their filtered reports.
 *
 * Wired into `check.ts`'s main entry as of PR2 (T1.6). Each stage's
 * `shouldRun(context, options)` gate decides whether the stage participates in
 * the current invocation; filters are applied to every emitted report before
 * the caller merges them.
 *
 * If the `generated` stage fails, the runner short-circuits and returns only
 * that one report. This preserves the v0.1 semantics that downstream stages
 * never observe a project with drifted generated files.
 */
export async function runAllStages(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
  options: CheckCommandOptions,
  filters: ReportFilters,
  skipStages?: ReadonlySet<string>,
): Promise<ViolationReport[]> {
  const reports: ViolationReport[] = [];
  for (const stage of topologicalSortStages(CHECK_STAGES)) {
    if (!stage.shouldRun(context, options)) continue;
    // Incremental skip (--changed-from / --changed): a file-scoped stage proven
    // unaffected by the changed source files. NEVER applies to global stages —
    // the caller's `skipStages` set only ever contains SKIPPABLE_STAGE_IDS.
    if (skipStages?.has(stage.id) ?? false) continue;
    const rawReport = await stage.build(context, protectedState, command);
    const filtered = applyFiltersToReport(rawReport, filters);
    reports.push(filtered);
    if (stage.id === "generated" && !filtered.ok) {
      return reports;
    }
  }
  return reports;
}

function isFullRun(options: CheckCommandOptions): boolean {
  return !(options.architectureOnly ?? false) && !(options.complexityOnly ?? false);
}

const STAGES: CheckStage[] = [
  {
    id: "generated",
    description: "Verify deterministically generated test files match the contract.",
    shouldRun: () => true,
    build: (context, _protectedState, command) => buildGeneratedStageReport(context, command),
  },
  {
    id: "protected",
    description: "Verify protected files match the manifest or baseline human_state.",
    dependsOn: ["generated"],
    shouldRun: () => true,
    build: (context, protectedState, command) => buildProtectedStageReport(context, protectedState, command),
  },
  {
    id: "code-shape",
    description: "Evaluate (code-shape ...) declarations against project sources.",
    shouldRun: (context, options) =>
      isFullRun(options) &&
      !(options.lenient ?? false) &&
      (context.codeShapeContract ?? context.contract).codeShapes.length > 0,
    build: (context, protectedState, command) => buildCodeShapeStageReport(context, protectedState, command),
  },
  {
    id: "design",
    description: "Verify design profile integrity (project, manifest, ownership).",
    shouldRun: (_context, options) =>
      isFullRun(options) || (options.architectureOnly ?? false),
    build: (context, protectedState, command) => buildDesignStage(context, protectedState, command),
  },
  {
    id: "toolchain",
    description: "Run profile-declared toolchain contracts (tsc, eslint, etc.).",
    shouldRun: (_context, options) => isFullRun(options),
    build: (context, protectedState, command) => buildToolchainStage(context, protectedState, command),
  },
  {
    id: "architecture",
    description: "Evaluate architecture dependency and cycle rules.",
    shouldRun: (_context, options) =>
      isFullRun(options) || (options.architectureOnly ?? false),
    build: (context, protectedState, command) => buildArchitectureStage(context, protectedState, command),
  },
  {
    id: "complexity",
    description: "Evaluate (core-node ...) complexity metrics.",
    shouldRun: (_context, options) =>
      isFullRun(options) || (options.complexityOnly ?? false),
    build: (context, protectedState, command) => buildComplexityStage(context, protectedState, command),
  },
  {
    id: "type-driven",
    description: "Enforce (branded-id ...) TypeScript checks.",
    shouldRun: (context, options) =>
      isFullRun(options) && context.contract.brandedIds.length > 0,
    build: (context, protectedState, command) => buildTypeDrivenStage(context, protectedState, command),
  },
  {
    id: "trace",
    description: "Evaluate (trace-policy ...) declarations against the project's call graph.",
    dependsOn: ["type-driven"],
    shouldRun: (context, options) =>
      isFullRun(options) && context.contract.tracePolicies.length > 0,
    build: (context, protectedState, command) => buildTraceStage(context, protectedState, command),
  },
  {
    id: "type-state",
    description: "Evaluate (type-state ...) declarations against the project's source code.",
    dependsOn: ["trace"],
    shouldRun: (context, options) =>
      isFullRun(options) && context.contract.typeStates.length > 0,
    build: (context, protectedState, command) =>
      buildTypeStateStage(context, protectedState, command),
  },
  {
    id: "effect",
    description: "Evaluate (effect-policy ...) declarations against the project's source code.",
    dependsOn: ["type-state"],
    shouldRun: (context, options) =>
      isFullRun(options) && context.contract.effectPolicies.length > 0,
    build: (context, protectedState, command) =>
      buildEffectStage(context, protectedState, command),
  },
];

/**
 * All check stages currently used by Stele, in declaration order.
 *
 * Declaration order is the tiebreaker for siblings during topological sort
 * (see `topologicalSortStages`). The array is frozen to prevent accidental
 * mutation at runtime.
 */
export const CHECK_STAGES: readonly CheckStage[] = Object.freeze(STAGES);
