import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createViolation,
  createViolationReport,
  ruleId,
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
  type TypedCallGraph,
} from "@stele/call-graph-core";
import type { TypeStateInferenceExtractor } from "@stele/type-state-evaluator";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { pickPhaseLanguage } from "../config/phase-language.js";
import { profilePathExists } from "../design-profile/load.js";
import { loadHashedProfile } from "../design-profile/lifecycle.js";
import {
  getCachedCallGraph,
  setCachedCallGraph,
  useCachedCallGraph,
  wrapExtractedGraph,
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

  const language = pickPhaseLanguage(context.config, "type-state");
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
          rule_id: ruleId(`typestate.not-yet-supported.${language}`),
          rule_kind: "typestate_unsupported_language",
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract" },
          cause: {
            summary: `type-state not yet supported for targetLanguage="${language}". Round 4 F-A-02: failing loud so the contract surface matches the enforcement surface.`,
          },
          scope_paths: ["contract"],
          status: "active",
          fix: {
            summary:
              "Stele Phase B.1 supports TypeScript only. Either remove the (type-state …) declarations or wait for B.2/B.3 backend coverage.",
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
          rule_id: ruleId("typestate.no-tsconfig"),
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

  // Closeout 4: typed CALLGRAPH_LIFECYCLE chain — cache returns
  // `TypedCallGraph<"Cached">`; `useCachedCallGraph` is the bound entry.
  let cached: TypedCallGraph<"Cached">;
  try {
    cached = await extractOrCacheCallGraph(context, tsconfigPath, deps);
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
          rule_id: ruleId("typestate.extraction_error"),
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
  const callGraph: CallGraph = useCachedCallGraph(cached);

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
          rule_id: ruleId("typestate.evaluation_error"),
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
  // Phase 0 (self-dogfooding plan): honour the optional config-level
  // `tsconfig` field first; see trace stage for the full rationale.
  let tsconfigPath = context.config.tsconfig
    ? resolve(context.projectDir, context.config.tsconfig)
    : resolve(context.projectDir, "tsconfig.json");
  if (profilePathExists(context.projectDir)) {
    try {
      // Closeout 4: typed DESIGN_PROFILE_LIFECYCLE chain.
      const hashed = loadHashedProfile(context.projectDir);
      if (hashed.profile.project?.tsconfig) {
        tsconfigPath = resolve(context.projectDir, hashed.profile.project.tsconfig);
      }
    } catch {
      // Fall back to default; profile errors are surfaced by the design
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
): Promise<TypedCallGraph<"Cached">> {
  // Closeout 4: typed CALLGRAPH_LIFECYCLE chain — see trace stage.
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
  const typed = wrapExtractedGraph(callGraph);
  setCachedCallGraph(context, typed);
  return typed;
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
