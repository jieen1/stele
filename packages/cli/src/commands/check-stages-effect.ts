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
  evaluateEffects,
  type EffectAnnotationExtractor,
  type EvaluateEffectResult,
} from "@stele/effect-evaluator";
import {
  buildExternAliasRegistry,
  type CallGraph,
  type CallGraphExtractor,
  type ExternAlias,
  type ExternAliasRegistry,
  type TypedCallGraph,
} from "@stele/call-graph-core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import {
  pickEffectAnnotationExtractor,
  pickEffectCallGraphExtractor,
} from "../backend-registry.js";
import { pickPhaseLanguage } from "../config/phase-language.js";
import { profilePathExists } from "../design-profile/load.js";
import { loadHashedProfile } from "../design-profile/lifecycle.js";
import {
  getCachedCallGraph,
  setCachedCallGraph,
  wrapExtractedGraph,
} from "./check-stages-call-graph-cache.js";

/**
 * Injection seam: tests replace the extractor + evaluator with stubs.
 * Production code falls back to the real TypeScript implementations.
 *
 * Closeout 1 (2026-05-25) removed the prior `strictMode` knob: the
 * effect evaluator now always emits `error`-severity violations for
 * unresolved calls that fall inside an active policy's `target-scope`,
 * and emits nothing for out-of-scope unresolved calls. There is no
 * opt-out — the `unresolved_call_blocks_evaluation` rule is policy-gated,
 * not config-gated.
 */
export interface EffectStageDeps {
  readonly extractCallGraph?: (options: {
    projectRoot: string;
    tsconfigPath: string;
    cacheDir: string;
  }) => Promise<CallGraph>;
  readonly evaluate?: typeof evaluateEffects;
  readonly extractor?: EffectAnnotationExtractor;
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

  const language = pickPhaseLanguage(context.config, "effect");
  const callGraphExtractor = pickEffectCallGraphExtractor(language);
  const effectAnnotationExtractor = pickEffectAnnotationExtractor(language);
  if (callGraphExtractor === null || effectAnnotationExtractor === null) {
    // Round 4 F-A-02 / Round 14 P0: fail loud when no Phase B extractor
    // pair exists for the target language. TypeScript + Python are
    // supported today; Go / Rust / Java still on the roadmap.
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
          rule_id: ruleId(`effect.not-yet-supported.${language}`),
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
              "Stele Phase B supports TypeScript + Python + Go today. Either remove the (effect-policy …) declarations or wait for Rust / Java backend coverage.",
          },
        }),
      ],
    });
  }

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
          rule_id: ruleId("effect.no-tsconfig"),
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

  // CALLGRAPH_LIFECYCLE: the cache returns a branded `TypedCallGraph<"Cached">`,
  // which the evaluator requires (ConsumableCallGraph).
  let cached: TypedCallGraph<"Cached">;
  try {
    cached = await extractOrCacheCallGraph(context, tsconfigPath, deps, callGraphExtractor);
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
          rule_id: ruleId("effect.extraction_error"),
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
  const extractor = deps.extractor ?? effectAnnotationExtractor;
  // Closeout 1 (2026-05-25): no strict-mode knob. Unresolved-call
  // emission is gated by per-policy `target-scope` membership inside the
  // evaluator. Out-of-scope unresolved calls emit nothing because no
  // policy cares; in-scope unresolved calls fail closed at error severity.
  // Round 4 D-07: build the cross-language alias registry from the
  // contract's (extern-alias ...) declarations and pass it to the
  // evaluator alongside the call graph + extractor.
  const externAliases =
    deps.externAliases ?? buildContractExternAliasRegistry(context.contract.externAliases);
  let result: EvaluateEffectResult;
  try {
    result = await evaluate({
      contract: context.contract,
      callGraph: cached,
      extractor,
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
          rule_id: ruleId("effect.evaluation_error"),
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

  // Zero-binding guard (symmetric with the trace + type-state stages): an
  // error-severity effect-policy whose target-scope matches 0 call-graph nodes
  // enforces nothing — a renamed file or mistyped glob would otherwise let the
  // policy pass green while protecting nothing. Surface it as an error.
  const zeroBindingViolations = buildEffectZeroBindingViolations(result.coverage, command);

  // Merge violations + notices. Notices (e.g. lenient-mode
  // unresolved_call_blocks_evaluation) are warning-severity findings that
  // surface through the report but do not flip `ok` to false because we key
  // `ok` off the error-severity count.
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
 * Emit an `effect.<id>.zero_binding` error for every error-severity
 * effect-policy whose target-scope bound 0 call-graph nodes. Mirrors the trace
 * and type-state zero-binding guards — no decorative green for a policy that
 * protects nothing.
 */
function buildEffectZeroBindingViolations(
  coverage: readonly { policyId: string; severity: string; scopeNodesMatched: number }[],
  command: string,
): Violation[] {
  const out: Violation[] = [];
  for (const c of coverage) {
    if (c.severity !== "error") continue;
    if (c.scopeNodesMatched > 0) continue;
    out.push(
      createViolation({
        rule_id: ruleId(`effect.${c.policyId}.zero_binding`),
        rule_kind: "effect_zero_binding",
        severity: "error",
        source: { tool: "stele", command, kind: "rule" },
        location: { path: "contract/main.stele" },
        cause: {
          summary:
            `Effect-policy \`${c.policyId}\` (severity=error) matched 0 call-graph nodes in its target-scope — ` +
            `it enforces nothing. A green check that protects nothing is not allowed.`,
        },
        scope_paths: ["contract/main.stele"],
        status: "active",
        fix: {
          summary:
            `Fix the policy's (target-scope …) so it resolves to real nodes (check for a renamed file or a ` +
            `mistyped glob / extern: alias), or remove the policy if the scope legitimately no longer exists.`,
        },
      }),
    );
  }
  return out;
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
  tsconfigPath: string | null,
  deps: EffectStageDeps,
  extractor: CallGraphExtractor,
): Promise<TypedCallGraph<"Cached">> {
  // Closeout 4: typed CALLGRAPH_LIFECYCLE chain — see trace stage.
  const cached = getCachedCallGraph(context);
  if (cached !== undefined) {
    return cached;
  }
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
