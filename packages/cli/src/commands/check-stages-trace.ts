import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createViolation,
  createViolationReport,
  type ExternAliasDeclaration,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import { evaluateTracePolicies } from "@stele/trace-evaluator";
import { tsCallGraphExtractor } from "@stele/backend-typescript";
import {
  buildExternAliasRegistry,
  type CallGraph,
  type ExternAlias,
  type ExternAliasRegistry,
} from "@stele/call-graph-core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { profilePathExists, loadProfile } from "../design-profile/load.js";
import {
  _clearCallGraphCacheForTests as _clearSharedCallGraphCacheForTests,
  getCachedCallGraph,
  setCachedCallGraph,
} from "./check-stages-call-graph-cache.js";

/**
 * Injection seam: tests replace the extractor with a stub. Production code
 * goes through the default `tsCallGraphExtractor`.
 */
export interface TraceStageDeps {
  readonly extractCallGraph?: (options: {
    projectRoot: string;
    tsconfigPath: string;
    cacheDir: string;
  }) => Promise<CallGraph>;
  readonly evaluate?: typeof evaluateTracePolicies;
  readonly externAliases?: ExternAliasRegistry;
}

/**
 * Trace stage: evaluates every (trace-policy ...) declaration in the contract
 * against the project's call graph.
 *
 * Skipped (returns ok report) when `context.contract.tracePolicies` is empty.
 *
 * Phase B B.1: TypeScript only. Python/Go/Java/Rust adapters land in B.2/B.3.
 * For non-TypeScript projects the stage currently returns ok with a warning
 * violation `trace.not-yet-supported.<lang>` so users see the gap without the
 * check failing.
 */
export async function buildTraceStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
  deps: TraceStageDeps = {},
): Promise<ViolationReport> {
  const tracePolicies = context.contract.tracePolicies;

  if (tracePolicies.length === 0) {
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
          rule_id: `trace.not-yet-supported.${language}`,
          rule_kind: "trace_unsupported_language",
          severity: "warning",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract" },
          cause: {
            summary: `trace-policy not yet supported for targetLanguage="${language}"; see Phase B roadmap.`,
          },
          scope_paths: ["contract"],
          status: "active",
          fix: {
            summary:
              "Stele Phase B.1 supports TypeScript only. Python lands in B.2; Go/Java/Rust in B.3.",
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
          rule_id: "trace.no-tsconfig",
          rule_kind: "trace_no_tsconfig",
          severity: "warning",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "tsconfig.json" },
          cause: {
            summary:
              "No tsconfig.json found at project root or in design profile; trace stage skipped.",
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
          rule_id: "trace.extraction_error",
          rule_kind: "trace_extraction_error",
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

  const evaluate = deps.evaluate ?? evaluateTracePolicies;
  // Round 3 P0-6: build the cross-language alias registry from the contract's
  // (extern-alias ...) declarations. Caller may inject a pre-built registry
  // (tests do this); production always derives it from the parsed contract.
  const externAliases =
    deps.externAliases ?? buildContractExternAliasRegistry(context.contract.externAliases);
  const result = evaluate({
    contract: context.contract,
    callGraph,
    externAliases,
  });

  // Merge violations + notices. Notices (e.g. path_exceeded_max_depth) are
  // warning-severity violations; including them in `violations` surfaces them
  // through normal report formatting but does not flip `ok` to false because
  // we key `ok` off the error-severity count.
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

function buildContractExternAliasRegistry(
  declarations: readonly ExternAliasDeclaration[] | undefined,
): ExternAliasRegistry | undefined {
  // Tests sometimes pass synthetic Contract values that pre-date the
  // externAliases field. Treat missing as "no aliases declared".
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

function resolveTsconfigPath(context: PreparedCheckContext): string | null {
  let tsconfigPath = resolve(context.projectDir, "tsconfig.json");
  if (profilePathExists(context.projectDir)) {
    try {
      const profile = loadProfile(context.projectDir);
      if (profile.project?.tsconfig) {
        tsconfigPath = resolve(context.projectDir, profile.project.tsconfig);
      }
    } catch {
      // Fall back to default; loadProfile errors are not the trace stage's
      // problem (the design stage will surface them).
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
  deps: TraceStageDeps,
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

/**
 * Test helper — clears the WeakMap cache. Production code should never call
 * this; the cache auto-clears when its key context object is GC'd. Exported
 * only so unit tests can assert "second call re-extracts after eviction".
 *
 * Delegates to the shared cache module so trace + type-state tests stay in
 * sync.
 */
export function _clearCallGraphCacheForTests(context: PreparedCheckContext): void {
  _clearSharedCallGraphCacheForTests(context);
}
