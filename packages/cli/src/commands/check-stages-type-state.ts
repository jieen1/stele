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
  evaluateTypeStates,
  type EvaluateTypeStateResult,
} from "@stele/type-state-evaluator";
import {
  tsCallGraphExtractor,
  tsTypeStateInferenceExtractor,
} from "@stele/backend-typescript";
import {
  buildExternAliasRegistry,
  type CallGraph,
  type ExternAlias,
  type ExternAliasRegistry,
} from "@stele/call-graph-core";
import type { TypeStateInferenceExtractor } from "@stele/type-state-evaluator";
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
export interface TypeStateStageDeps {
  readonly extractCallGraph?: (options: {
    projectRoot: string;
    tsconfigPath: string;
    cacheDir: string;
  }) => Promise<CallGraph>;
  readonly evaluate?: typeof evaluateTypeStates;
  readonly extractor?: TypeStateInferenceExtractor;
  /**
   * Per Round 2 D-CG-1, strict mode (default true) routes inference failures
   * to `violations` (severity=error). Tests can flip this to exercise the
   * notice path.
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
 * Type-state stage: evaluates every (type-state ...) declaration in the
 * contract against the project's source code using the per-backend
 * `TypeStateInferenceExtractor`.
 *
 * Skipped (returns ok report) when `context.contract.typeStates` is empty.
 *
 * Phase B B.1: TypeScript only. For non-TypeScript projects the stage
 * returns ok with a warning violation `typestate.not-yet-supported.<lang>`
 * so users see the gap without the check failing.
 */
export async function buildTypeStateStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
  deps: TypeStateStageDeps = {},
): Promise<ViolationReport> {
  const typeStates = context.contract.typeStates;

  if (typeStates.length === 0) {
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
          rule_id: `typestate.not-yet-supported.${language}`,
          rule_kind: "typestate_unsupported_language",
          severity: "warning",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract" },
          cause: {
            summary: `type-state not yet supported for targetLanguage="${language}"; see Phase B roadmap.`,
          },
          scope_paths: ["contract"],
          status: "active",
          fix: {
            summary:
              "Stele Phase B.1 supports TypeScript only. Python/Rust/Java/Go land in later milestones.",
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
          rule_id: "typestate.no-tsconfig",
          rule_kind: "typestate_no_tsconfig",
          severity: "warning",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "tsconfig.json" },
          cause: {
            summary:
              "No tsconfig.json found at project root or in design profile; type-state stage skipped.",
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
          rule_id: "typestate.extraction_error",
          rule_kind: "typestate_extraction_error",
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

  const evaluate = deps.evaluate ?? evaluateTypeStates;
  const extractor = deps.extractor ?? tsTypeStateInferenceExtractor;
  const strictMode = deps.strictMode ?? true;
  // Round 4 D-07: cross-language alias registry construction mirrors the
  // trace + effect stages — see those for rationale.
  const externAliases =
    deps.externAliases ?? buildContractExternAliasRegistry(context.contract.externAliases);

  let result: EvaluateTypeStateResult;
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
          rule_id: "typestate.evaluation_error",
          rule_kind: "typestate_evaluation_error",
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract" },
          cause: {
            summary: `Type-state evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
          },
          scope_paths: ["contract"],
          status: "active",
          fix: {
            summary:
              "Inspect the type-state declarations and project sources; ensure they compile before re-running stele check.",
          },
        }),
      ],
    });
  }

  // Merge violations + notices. Notices (e.g. lenient-mode inference_failed)
  // are warning-severity findings that surface through the report but do not
  // flip `ok` to false because we key `ok` off the error-severity count.
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
  deps: TypeStateStageDeps,
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
