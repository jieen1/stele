import type * as ts from "typescript";
import type { ExternAliasRegistry } from "@stele/call-graph-core";

/**
 * Internal extractor context — produced once per `extract()` call and
 * threaded through every helper. Holds the `ts.Program` + checker so we
 * never re-create them.
 */
export interface ExtractorContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** Absolute path. */
  readonly projectRoot: string;
  /**
   * POSIX relative paths to include. When empty, every source file
   * inside `projectRoot` (excluding `node_modules`) is extracted.
   */
  readonly sourceFiles: ReadonlySet<string>;
  readonly externAliasRegistry?: ExternAliasRegistry;
}

/**
 * Output of `resolveCallee` — the resolver may return zero, one, or
 * multiple candidate NodeIds. The reason field carries the bucket label
 * for `unresolvedCalls` when `kind === "unresolved"`.
 */
export interface ResolvedCallee {
  readonly kind: "resolved" | "unresolved" | "ambiguous";
  readonly nodeIds: readonly string[];
  readonly reason?: "dynamic" | "reflection" | "module-not-resolved" | "external-lib";
  readonly rawText?: string;
}
