import * as core from "@actions/core";
import type { Violation } from "@stele/core";

export const MAX_ERROR_ANNOTATIONS = 50;
export const MAX_WARNING_ANNOTATIONS = 50;

export interface AnnotationSink {
  error: (message: string, properties?: AnnotationProperties) => void;
  warning: (message: string, properties?: AnnotationProperties) => void;
  notice: (message: string, properties?: AnnotationProperties) => void;
}

interface AnnotationProperties {
  title?: string;
  file?: string;
  startLine?: number;
}

const defaultSink: AnnotationSink = {
  error: (message, properties) => core.error(message, properties),
  warning: (message, properties) => core.warning(message, properties),
  notice: (message, properties) => core.notice(message, properties),
};

/**
 * Emit GitHub annotations for a list of violations, capped at 50 errors and
 * 50 warnings. When the cap is hit a `notice` is emitted that points users to
 * the PR comment for the full list (or just states the cap when PR comments
 * are disabled).
 */
export function emitAnnotations(
  violations: Violation[],
  totalCount: number,
  prCommentEnabled: boolean,
  sink: AnnotationSink = defaultSink,
): void {
  const errors = violations.filter((v) => v.severity === "error").slice(0, MAX_ERROR_ANNOTATIONS);
  const warnings = violations
    .filter((v) => v.severity === "warning")
    .slice(0, MAX_WARNING_ANNOTATIONS);

  for (const violation of errors) {
    emit(sink, "error", violation);
  }
  for (const violation of warnings) {
    emit(sink, "warning", violation);
  }

  const shown = errors.length + warnings.length;
  if (totalCount > shown) {
    const tail = prCommentEnabled ? " See PR comment for full list." : "";
    sink.notice(
      `Showing ${shown} of ${totalCount} violations as inline annotations.${tail}`,
    );
  }
}

function emit(sink: AnnotationSink, level: "error" | "warning", v: Violation): void {
  // Real schema (cli-output.md §2): rule_id (NOT invariant_id),
  // location.path (NOT location.file), cause.summary (NOT cause.detail.message).
  const file = v.location?.path;
  const line = v.location?.line ?? 1;
  const message = v.cause.summary;

  if (file) {
    sink[level](message, {
      title: `Stele: ${v.rule_id}`,
      file,
      startLine: line,
    });
  } else {
    // No path (e.g. manifest drift) → emit as a global annotation so the
    // message still shows up in the run log even without a file anchor.
    sink[level](`Stele: ${v.rule_id}: ${message}`);
  }
}
