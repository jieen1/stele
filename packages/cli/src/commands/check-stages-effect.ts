import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createViolation,
  createViolationReport,
  type ExternAliasDeclaration,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import {
  evaluateEffects,
  type EffectAnnotationExtractor,
  type EvaluateEffectResult,
} from "@stele/effect-evaluator";
import {
  tsCallGraphExtractor,
  tsEffectAnnotationExtractor,
} from "@stele/backend-typescript";
import {
  buildExternAliasRegistry,
  type CallGraph,
  type ExternAlias,
  type ExternAliasRegistry,
} from "@stele/call-graph-core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { profilePathExists, loadProfile } from "../design-profile/load.js";
import {
  getCachedCallGraph,
  setCachedCallGraph,
} from "./check-stages-call-graph-cache.js";

/**
 * Injection seam: tests replace the extractor + evaluator with stubs.
 * Production code falls back to the real TypeScript implementations.
 */
export interface EffectStageDeps {
  readonly extractCallGraph?: (options: {
    projectRoot: string;
    tsconfigPath: string;
    cacheDir: string;
  }) => Promise<CallGraph>;
  readonly evaluate?: typeof evaluateEffects;
  readonly extractor?: EffectAnnotationExtractor;
  /**
   * Per Round 2 D-CG-1, strict mode (default true) routes unresolved-call
   * failures to `violations` (severity=error). Tests can flip this to
   * exercise the notice path.
   */
  readonly strictMode?: boolean;
  /** Round 4 D-07 — pre-built registry override for tests. */
  readonly externAliases?: ExternAliasRegistry;
}

function buildContractExternAliasRegistry(
  declarations: readonly ExternAliasDeclaration[] | undefined,
): ExternAliasRegistry | undefined {
  if (declarations === undefined || declarations.length === 0) {
    return undefined;
  }
  const aliases: ExternAlias[] = declarations.map((d) => ({
    logicalName: d.id,
    typescript: d.typescript,
    python: d.python,
    go: d.go,
    java: d.java,
    rust: d.rust,
  }));
  return buildExternAliasRegistry(aliases);
}

/**
 * Effect stage: evaluates every (effect-policy ...) declaration in the
 * contract against the project's source code using the per-backend
 * `EffectAnnotationExtractor` + the shared call graph.
 *
 * Skipped (returns ok report) when `context.contract.effectPolicies` is empty.
 *
 * Phase B B.1: TypeScript only. For non-TypeScript projects the stage
 * returns ok with a warning violation `effect.not-yet-supported.<lang>`
 * so users see the gap without the check failing.
 */
export async function buildEffectStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
  deps: EffectStageDeps = {},
): Promise<ViolationReport> {
  const effectPolicies = context.contract.effectPolicies;

  if (effectPolicies.length === 0) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        generated_file_count: protectedState.summary.generatedFileCount,
        protected_file_count: protectedState.summary.protectedFileCount,
        violation_count: 0,
      },
      violations: [],
    });
  }

  const language = context.config.targetLanguage;
  if (language !== "typescript") {
    // Round 4 F-A-02: fail loud (error+ok:false) instead of silent
    // warning. See trace stage for the full rationale.
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        generated_file_count: protectedState.summary.generatedFileCount,
        protected_file_count: protectedState.summary.protectedFileCount,
        violation_count: 1,
      },
      violations: [
        createViolation({
          rule_id: `effect.not-yet-supported.${language}`,
          rule_kind: "effect_unsupported_language",
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract" },
          cause: {
            summary: `effect-policy not yet supported for targetLanguage="${language}". Round 4 F-A-02: failing loud so the contract surface matches the enforcement surface.`,
          },
          scope_paths: ["contract"],
          status: "active",
          fix: {
            summary:
              "Stele Phase B.1 supports TypeScript only. Either remove the (effect-policy …) declarations or wait for B.2/B.3 backend coverage.",
          },
        }),
      ],
    });
  }

  const tsconfigPath = resolveTsconfigPath(context);
  if (tsconfigPath === null) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        generated_file_count: protectedState.summary.generatedFileCount,
        protected_file_count: protectedState.summary.protectedFileCount,
        violation_count: 0,
      },
      violations: [
        createViolation({
          rule_id: "effect.no-tsconfig",
          rule_kind: "effect_no_tsconfig",
          severity: "warning",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "tsconfig.json" },
          cause: {
            summary:
              "No tsconfig.json found at project root or in design profile; effect stage skipped.",
          },
          scope_paths: ["tsconfig.json"],
          status: "active",
          fix: {
            summary:
              "Create a tsconfig.json at the project root or declare it in the design profile.",
          },
        }),
      ],
    });
  }

  let callGraph: CallGraph;
  try {
    callGraph = await extractOrCacheCallGraph(context, tsconfigPath, deps);
  } catch (error) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        generated_file_count: protectedState.summary.generatedFileCount,
        protected_file_count: protectedState.summary.protectedFileCount,
        violation_count: 1,
      },
      violations: [
        createViolation({
          rule_id: "effect.extraction_error",
          rule_kind: "effect_extraction_error",
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "tsconfig.json" },
          cause: {
            summary: `Call graph extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          scope_paths: ["tsconfig.json"],
          status: "active",
          fix: {
            summary:
              "Inspect the tsconfig and project sources; ensure they compile before re-running stele check.",
          },
        }),
      ],
    });
  }

  const evaluate = deps.evaluate ?? evaluateEffects;
  const extractor = deps.extractor ?? tsEffectAnnotationExtractor;
  const strictMode = deps.strictMode ?? true;
  // Round 4 D-07: build the cross-language alias registry from the
  // contract's (extern-alias ...) declarations and pass it to the
  // evaluator alongside the call graph + extractor.
  const externAliases =
    deps.externAliases ?? buildContractExternAliasRegistry(context.contract.externAliases);

  let result: EvaluateEffectResult;
  try {
    result = await evaluate({
      contract: context.contract,
      callGraph,
      extractor,
      strictMode,
      externAliases,
    });
  } catch (error) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: false,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        generated_file_count: protectedState.summary.generatedFileCount,
        protected_file_count: protectedState.summary.protectedFileCount,
        violation_count: 1,
      },
      violations: [
        createViolation({
          rule_id: "effect.evaluation_error",
          rule_kind: "effect_evaluation_error",
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract" },
          cause: {
            summary: `Effect evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          scope_paths: ["contract"],
          status: "active",
          fix: {
            summary:
              "Inspect the effect-policy declarations and project sources; ensure they compile before re-running stele check.",
          },
        }),
      ],
    });
  }

  // Merge violations + notices. Notices (e.g. lenient-mode
  // unresolved_call_blocks_evaluation) are warning-severity findings that
  // surface through the report but do not flip `ok` to false because we key
  // `ok` off the error-severity count.
  const allViolations: Violation[] = [...result.violations, ...result.notices];

  return createViolationReport({
    tool: "stele",
    command,
    ok: result.violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      generated_file_count: protectedState.summary.generatedFileCount,
      protected_file_count: protectedState.summary.protectedFileCount,
      violation_count: result.violations.length,
    },
    violations: allViolations,
  });
}

function resolveTsconfigPath(context: PreparedCheckContext): string | null {
  let tsconfigPath = resolve(context.projectDir, "tsconfig.json");
  if (profilePathExists(context.projectDir)) {
    try {
      const profile = loadProfile(context.projectDir);
      if (profile.project?.tsconfig) {
        tsconfigPath = resolve(context.projectDir, profile.project.tsconfig);
      }
    } catch {
      // Fall back to default; loadProfile errors are surfaced by the design
      // stage, not this one.
    }
  }
  if (!existsSync(tsconfigPath)) {
    return null;
  }
  return tsconfigPath;
}

async function extractOrCacheCallGraph(
  context: PreparedCheckContext,
  tsconfigPath: string,
  deps: EffectStageDeps,
): Promise<CallGraph> {
  const cached = getCachedCallGraph(context);
  if (cached !== undefined) {
    return cached;
  }
  const extract = deps.extractCallGraph ?? defaultExtract;
  const callGraph = await extract({
    projectRoot: context.projectDir,
    tsconfigPath,
    cacheDir: resolve(context.projectDir, "contract/.cache"),
  });
  setCachedCallGraph(context, callGraph);
  return callGraph;
}

async function defaultExtract(options: {
  projectRoot: string;
  tsconfigPath: string;
  cacheDir: string;
}): Promise<CallGraph> {
  return tsCallGraphExtractor.extract({
    projectRoot: options.projectRoot,
    tsconfigPath: options.tsconfigPath,
    cacheDir: options.cacheDir,
  });
}
