import { describe, expect, it, vi } from "vitest";
import {
  emitAnnotations,
  MAX_ERROR_ANNOTATIONS,
  MAX_WARNING_ANNOTATIONS,
  type AnnotationSink,
} from "../src/annotate.js";
import { makeViolation } from "./test-helpers.js";

function makeSink(): AnnotationSink & {
  errorCalls: Array<[string, Record<string, unknown> | undefined]>;
  warningCalls: Array<[string, Record<string, unknown> | undefined]>;
  noticeCalls: Array<[string, Record<string, unknown> | undefined]>;
} {
  const errorCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const warningCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const noticeCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    error: (message, properties) => {
      errorCalls.push([message, properties as Record<string, unknown> | undefined]);
    },
    warning: (message, properties) => {
      warningCalls.push([message, properties as Record<string, unknown> | undefined]);
    },
    notice: (message, properties) => {
      noticeCalls.push([message, properties as Record<string, unknown> | undefined]);
    },
    errorCalls,
    warningCalls,
    noticeCalls,
  };
}

describe("emitAnnotations", () => {
  it("caps error annotations at MAX_ERROR_ANNOTATIONS", () => {
    const violations = Array.from({ length: 60 }, (_unused, index) =>
      makeViolation({ rule_id: `RULE_${index}`, severity: "error" }),
    );
    const sink = makeSink();

    emitAnnotations(violations, violations.length, true, sink);

    expect(sink.errorCalls.length).toBe(MAX_ERROR_ANNOTATIONS);
    expect(sink.warningCalls.length).toBe(0);
    expect(sink.noticeCalls.length).toBe(1);
    expect(sink.noticeCalls[0]?.[0]).toContain(`Showing ${MAX_ERROR_ANNOTATIONS} of 60 violations`);
    expect(sink.noticeCalls[0]?.[0]).toContain("See PR comment for full list.");
  });

  it("caps warning annotations independently from errors", () => {
    const violations = [
      ...Array.from({ length: 5 }, (_unused, index) =>
        makeViolation({ rule_id: `E_${index}`, severity: "error" }),
      ),
      ...Array.from({ length: 60 }, (_unused, index) =>
        makeViolation({ rule_id: `W_${index}`, severity: "warning" }),
      ),
    ];
    const sink = makeSink();

    emitAnnotations(violations, violations.length, true, sink);

    expect(sink.errorCalls.length).toBe(5);
    expect(sink.warningCalls.length).toBe(MAX_WARNING_ANNOTATIONS);
    // 5 errors + 50 warnings = 55 shown of 65 total → notice expected
    expect(sink.noticeCalls[0]?.[0]).toContain("Showing 55 of 65 violations");
  });

  it("omits the 'See PR comment' tail when prCommentEnabled is false", () => {
    const violations = Array.from({ length: 60 }, (_unused, index) =>
      makeViolation({ rule_id: `RULE_${index}`, severity: "error" }),
    );
    const sink = makeSink();

    emitAnnotations(violations, violations.length, false, sink);

    expect(sink.noticeCalls.length).toBe(1);
    const notice = sink.noticeCalls[0]?.[0] ?? "";
    expect(notice).toContain("Showing 50 of 60 violations");
    expect(notice).not.toContain("See PR comment");
  });

  it("does not emit a cap notice when nothing was capped", () => {
    const violations = Array.from({ length: 3 }, (_unused, index) =>
      makeViolation({ rule_id: `RULE_${index}` }),
    );
    const sink = makeSink();

    emitAnnotations(violations, violations.length, true, sink);

    expect(sink.errorCalls.length).toBe(3);
    expect(sink.noticeCalls.length).toBe(0);
  });

  it("reads v.rule_id (not invariant_id)", () => {
    const violation = makeViolation({ rule_id: "REAL_RULE_ID" });
    // Defensive: write a fake invariant_id that should be ignored.
    (violation as Record<string, unknown>).invariant_id = "WRONG_FIELD";
    const sink = makeSink();

    emitAnnotations([violation], 1, true, sink);

    const [, properties] = sink.errorCalls[0] ?? [];
    expect(properties?.title).toBe("Stele: REAL_RULE_ID");
    expect(JSON.stringify(properties)).not.toContain("WRONG_FIELD");
  });

  it("reads v.location.path (not v.location.file)", () => {
    const violation = makeViolation({ location: { path: "real/path.ts", line: 7 } });
    (violation.location as Record<string, unknown>).file = "wrong/path.ts";
    const sink = makeSink();

    emitAnnotations([violation], 1, true, sink);

    const [, properties] = sink.errorCalls[0] ?? [];
    expect(properties?.file).toBe("real/path.ts");
    expect(properties?.startLine).toBe(7);
  });

  it("reads v.cause.summary (not v.cause.detail.message)", () => {
    const violation = makeViolation({
      cause: {
        summary: "real summary message",
        detail: "extra detail string",
      },
    });
    // Defensively set a structured detail to confirm we don't pull from it.
    const sink = makeSink();

    emitAnnotations([violation], 1, true, sink);

    expect(sink.errorCalls[0]?.[0]).toBe("real summary message");
  });

  it("falls back to a global annotation when location.path is absent", () => {
    const violation = makeViolation({
      rule_id: "MANIFEST_DRIFT",
      location: {},
      cause: { summary: "manifest hashes diverged" },
    });
    const sink = makeSink();

    emitAnnotations([violation], 1, true, sink);

    expect(sink.errorCalls.length).toBe(1);
    const [message, properties] = sink.errorCalls[0] ?? [];
    expect(message).toBe("Stele: MANIFEST_DRIFT: manifest hashes diverged");
    expect(properties).toBeUndefined();
  });

  it("uses default line=1 when location.line is missing but path is present", () => {
    const violation = makeViolation({
      location: { path: "src/foo.ts" },
    });
    const sink = makeSink();

    emitAnnotations([violation], 1, true, sink);

    expect(sink.errorCalls[0]?.[1]?.startLine).toBe(1);
  });
});
