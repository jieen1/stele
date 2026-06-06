import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createViolation,
  createViolationReport,
  ruleId,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import { evaluateTracePolicies } from "@stele/trace-evaluator";
import {
  buildExternAliasRegistry,
  type CallGraph,
  type CallGraphExtractor,
  type ExternAlias,
  type ExternAliasRegistry,
  type TypedCallGraph,
} from "@stele/call-graph-core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import { pickTraceCallGraphExtractor } from "../backend-registry.js";
import { pickPhaseLanguage } from "../config/phase-language.js";
import { profilePathExists } from "../design-profile/load.js";
import { loadHashedProfile } from "../design-profile/lifecycle.js";
import {
  _clearCallGraphCacheForTests as _clearSharedCallGraphCacheForTests,
  getCachedCallGraph,
  setCachedCallGraph,
  wrapExtractedGraph,
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
  const extractor = pickTraceCallGraphExtractor(language);
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

  // CALLGRAPH_LIFECYCLE: the cache returns a branded `TypedCallGraph<"Cached">`,
  // which the evaluator requires (ConsumableCallGraph).
  let cached: TypedCallGraph<"Cached">;
  try {
    cached = await extractOrCacheCallGraph(context, tsconfigPath, deps, extractor);
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

  // Round 3 P0-6: build the cross-language alias registry from the contract's
  // (extern-alias ...) declarations. Caller may inject a pre-built registry
  // (tests do this); production always derives it from the parsed contract.
  let externAliases = deps.externAliases;
  const externAliasDeclarations = context.contract.externAliases ?? [];
  if (externAliases === undefined && externAliasDeclarations.length > 0) {
    const aliases: ExternAlias[] = externAliasDeclarations.map((d) => ({
      logicalName: d.id,
      typescript: d.typescript,
      python: d.python,
      go: d.go,
      java: d.java,
      rust: d.rust,
    }));
    externAliases = buildExternAliasRegistry(aliases);
  }
  const evaluationOptions = {
    contract: context.contract,
    callGraph: cached,
    externAliases,
  };
  const result =
    deps.evaluate === undefined
      ? evaluateTracePolicies(evaluationOptions)
      : deps.evaluate(evaluationOptions);

  // Zero-binding guard (symmetric with the type-state stage): an error-severity
  // trace-policy whose target pattern matches 0 nodes in the call graph
  // enforces nothing. Previously the evaluator silently skipped it and the
  // stage reported green — a policy that binds nothing protects nothing. We now
  // surface it as an error so a renamed target / broken extern alias can't
  // silently neuter a policy.
  const zeroBindingViolations = buildTraceZeroBindingViolations(result.coverage, command);

  // Merge violations + notices. In strict mode (the default) an incomplete
  // enumeration (`path_exceeded_max_depth`, Round 3 P0-5) is already pushed to
  // `result.violations` — a policy that cannot be proven fails CLOSED, not as
  // a silent warning. `result.notices` only carries genuinely advisory items
  // (and the lenient-mode demotion of the depth cap); they surface through the
  // report but do not flip `ok`, which keys off the error-severity count.
  const errorViolations: Violation[] = [...result.violations, ...zeroBindingViolations];
  const allViolations: Violation[] = [...errorViolations, ...result.notices];

  return createViolationReport({
    tool: "stele",
    command,
    ok: errorViolations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      generated_file_count: protectedState.summary.generatedFileCount,
      protected_file_count: protectedState.summary.protectedFileCount,
      violation_count: errorViolations.length,
    },
    violations: allViolations,
  });
}

/**
 * Emit a `trace.<id>.zero_binding` error for every error-severity trace-policy
 * whose `(target …)` matched no call-graph nodes. Mirrors the type-state
 * stage's zero-binding guard — no decorative green for a policy bound to
 * nothing.
 */
function buildTraceZeroBindingViolations(
  coverage: readonly { policyId: string; severity: string; targetsMatched: number; scopeNodesMatched: number }[],
  command: string,
): Violation[] {
  const out: Violation[] = [];
  for (const c of coverage) {
    if (c.severity !== "error") continue;
    // A policy enforces something only if BOTH its targets AND its in-scope
    // callers are present. targetsMatched > 0 alone is not enough: the targets
    // are usually global externs (writeFileSync, …) that exist regardless of
    // whether any in-scope caller reaches them, so a policy whose scope matched
    // 0 nodes (e.g. a renamed scope path) would otherwise stay vacuously green.
    if (c.targetsMatched > 0 && c.scopeNodesMatched > 0) continue;
    const reason =
      c.targetsMatched === 0
        ? `matched 0 target nodes`
        : `matched 0 in-scope caller nodes (scope resolves to nothing)`;
    out.push(
      createViolation({
        rule_id: ruleId(`trace.${c.policyId}.zero_binding`),
        rule_kind: "trace_zero_binding",
        severity: "error",
        source: { tool: "stele", command, kind: "rule" },
        location: { path: "contract/main.stele" },
        cause: {
          summary:
            `Trace-policy \`${c.policyId}\` (severity=error) ${reason} in the call graph — ` +
            `it enforces nothing. A green check that protects nothing is not allowed.`,
        },
        scope_paths: ["contract/main.stele"],
        status: "active",
        fix: {
          summary:
            `Fix the policy's (target …) so it resolves to a real node (check for a renamed symbol or a broken ` +
            `extern: alias), or remove the policy if the target legitimately no longer exists.`,
        },
      }),
    );
  }
  return out;
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
): Promise<TypedCallGraph<"Cached">> {
  // Closeout 4: typed CALLGRAPH_LIFECYCLE chain — return the cached
  // value directly (it is `TypedCallGraph<"Cached">`); otherwise wrap a
  // fresh extraction through `wrapExtractedGraph` so the typestate
  // transitions Empty → Building → Built → Cached happen exactly once
  // per cache miss.
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
  const typed = wrapExtractedGraph(callGraph);
  setCachedCallGraph(context, typed);
  return typed;
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
