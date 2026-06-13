import type { CallGraph } from "./types.js";

const UNRESOLVED_REASONS = new Set([
  "dynamic",
  "reflection",
  "module-not-resolved",
  "external-lib",
]);

/**
 * Fail-loud structural validation for a CallGraph produced OUTSIDE the
 * TypeScript process — i.e. a language backend that emits the graph as JSON
 * over a subprocess boundary. The in-process TS extractor is type-checked at
 * compile time, but a JSON-producing backend is only `as CallGraph`-cast on
 * ingest, so a dropped field is invisible until it silently changes a verdict.
 *
 * The load-bearing field is `UnresolvedCall.nameHidden`: the trace-policy
 * fail-closed gate fires ONLY on `nameHidden === true`. If a backend omits it,
 * `nameHidden` reads `undefined`, `!undefined` is truthy, every unresolved call
 * is skipped, and fail-closed is silently disabled — the exact regression this
 * guards against. Validate it as a strict boolean so a missing value is a loud
 * error, never a weakened guarantee.
 *
 * Intentionally shallow: it checks the soundness-critical shape of the
 * unresolved-call array, not the whole graph. `source` names the producer for
 * the error message (e.g. "python extractor").
 */
export function assertValidCallGraph(graph: CallGraph, source: string): void {
  const unresolved: unknown = (graph as { unresolvedCalls?: unknown }).unresolvedCalls;
  if (!Array.isArray(unresolved)) {
    throw new Error(
      `[stele:callgraph] ${source}: \`unresolvedCalls\` must be an array (got ${typeof unresolved}).`,
    );
  }
  for (let i = 0; i < unresolved.length; i++) {
    const u = unresolved[i] as Record<string, unknown> | null | undefined;
    if (u === null || typeof u !== "object") {
      throw new Error(
        `[stele:callgraph] ${source}: unresolvedCalls[${i}] is not an object.`,
      );
    }
    if (typeof u.nameHidden !== "boolean") {
      throw new Error(
        `[stele:callgraph] ${source}: unresolvedCalls[${i}] is missing the boolean ` +
          `\`nameHidden\` field (got ${typeof u.nameHidden}). The trace-policy fail-closed ` +
          `gate keys on nameHidden; a missing value silently disables it. The extractor ` +
          `MUST classify every unresolved call as name-hidden or name-visible.`,
      );
    }
    if (typeof u.fromId !== "string") {
      throw new Error(
        `[stele:callgraph] ${source}: unresolvedCalls[${i}].fromId must be a string.`,
      );
    }
    if (typeof u.reason !== "string" || !UNRESOLVED_REASONS.has(u.reason)) {
      throw new Error(
        `[stele:callgraph] ${source}: unresolvedCalls[${i}].reason ${JSON.stringify(u.reason)} ` +
          `is not one of ${[...UNRESOLVED_REASONS].join(", ")}.`,
      );
    }
  }
}
