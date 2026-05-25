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
import { evaluateTracePolicies } from "@stele/trace-evaluator";
import { tsCallGraphExtractor } from "@stele/backend-typescript";
import { pyCallGraphExtractor } from "@stele/backend-python";
import {
  buildExternAliasRegistry,
  type CallGraph,
  type CallGraphExtractor,
  type ExternAlias,
  type ExternAliasRegistry,
} from "@stele/call-graph-core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { pickPhaseLanguage } from "../config/phase-language.js";
import { profilePathExists } from "../design-profile/load.js";
import { loadHashedProfile } from "../design-profile/lifecycle.js";
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

  const language = pickPhaseLanguage(context.config, "trace");
  const extractor = pickCallGraphExtractor(language);
  if (extractor === null) {
    // Round 4 F-A-02 / Round 14 P0: fail loud only when NO extractor
    // exists for the language. TypeScript (B.1) and Python (B.2 —
    // Round 14) are supported; Go / Rust / Java still surface as
    // unsupported until their extractors land.
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
          rule_id: ruleId(`trace.not-yet-supported.${language}`),
          rule_kind: "trace_unsupported_language",
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract" },
          cause: {
            summary: `trace-policy not yet supported for targetLanguage="${language}". Round 4 F-A-02: failing loud so the contract surface matches the enforcement surface.`,
          },
          scope_paths: ["contract"],
          status: "active",
          fix: {
            summary:
              "Stele Phase B supports TypeScript + Python today. Either remove the (trace-policy …) declarations from this contract, or wait for the Go / Java / Rust backend to land.",
          },
        }),
      ],
    });
  }

  // TypeScript still needs a tsconfig.json to bootstrap the compiler
  // program; Python does not.
  const tsconfigPath = language === "typescript" ? resolveTsconfigPath(context) : null;
  if (language === "typescript" && tsconfigPath === null) {
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
          rule_id: ruleId("trace.no-tsconfig"),
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
    callGraph = await extractOrCacheCallGraph(context, tsconfigPath, deps, extractor);
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
          rule_id: ruleId("trace.extraction_error"),
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
  // Phase 0 (self-dogfooding plan): honour the optional config-level
  // `tsconfig` field first — this lets a project that lives under a
  // non-default tsconfig (e.g. tsconfig.base.json in a monorepo) wire
  // it once in stele.config.json instead of relying on the design
  // profile.
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
      // Fall back to default; profile errors are not the trace stage's
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
  tsconfigPath: string | null,
  deps: TraceStageDeps,
  extractor: CallGraphExtractor,
): Promise<CallGraph> {
  const cached = getCachedCallGraph(context);
  if (cached !== undefined) {
    return cached;
  }
  // Tests can inject `deps.extractCallGraph` to bypass the real
  // extractor; production routes through whichever extractor matched
  // the target language.
  const extract = deps.extractCallGraph ?? ((options) => extractor.extract({
    projectRoot: options.projectRoot,
    tsconfigPath: options.tsconfigPath || undefined,
    cacheDir: options.cacheDir,
  }));
  const callGraph = await extract({
    projectRoot: context.projectDir,
    tsconfigPath: tsconfigPath ?? "",
    cacheDir: resolve(context.projectDir, "contract/.cache"),
  });
  setCachedCallGraph(context, callGraph);
  return callGraph;
}

/**
 * Round 14 P0: pick the CallGraph extractor for a target language.
 * Returns null when no extractor is registered — the caller then
 * fail-louds the stage per F-A-02.
 */
function pickCallGraphExtractor(language: string): CallGraphExtractor | null {
  if (language === "typescript") return tsCallGraphExtractor;
  if (language === "python") return pyCallGraphExtractor;
  return null;
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
