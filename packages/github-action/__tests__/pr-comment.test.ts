import { describe, expect, it, vi } from "vitest";
import {
  COMMENT_MARKER,
  renderComment,
  renderViolation,
  upsertPrComment,
  type CommentClient,
  type CommentContext,
} from "../src/pr-comment.js";
import { makeReport, makeViolation } from "./test-helpers.js";

function makeClient(initial: Array<{ id: number; body?: string }> = []): CommentClient & {
  paginateCalls: number;
  createCalls: Array<{ owner: string; repo: string; issue_number: number; body: string }>;
  updateCalls: Array<{ owner: string; repo: string; comment_id: number; body: string }>;
} {
  const paginateCalls = { count: 0 };
  const createCalls: Array<{ owner: string; repo: string; issue_number: number; body: string }> = [];
  const updateCalls: Array<{ owner: string; repo: string; comment_id: number; body: string }> = [];
  const client = {
    paginate: vi.fn(async () => {
      paginateCalls.count += 1;
      return initial;
    }),
    rest: {
      issues: {
        listComments: vi.fn(),
        updateComment: vi.fn(async (parameters: {
          owner: string;
          repo: string;
          comment_id: number;
          body: string;
        }) => {
          updateCalls.push(parameters);
          return parameters;
        }),
        createComment: vi.fn(async (parameters: {
          owner: string;
          repo: string;
          issue_number: number;
          body: string;
        }) => {
          createCalls.push(parameters);
          return parameters;
        }),
      },
    },
  } as unknown as CommentClient;

  return Object.assign(client, {
    get paginateCalls() {
      return paginateCalls.count;
    },
    createCalls,
    updateCalls,
  });
}

function makeContext(overrides: Partial<CommentContext> = {}): CommentContext {
  return {
    payload: { pull_request: { number: 42 } },
    repo: { owner: "stelehq", repo: "stele" },
    runId: 99,
    serverUrl: "https://github.com",
    ...overrides,
  };
}

describe("upsertPrComment", () => {
  it("creates a new comment when none exist", async () => {
    const client = makeClient([]);
    const violations = [makeViolation()];
    const report = makeReport(violations);

    const action = await upsertPrComment(violations, report, {
      client,
      context: makeContext(),
      token: "ghs_test",
      now: () => new Date("2026-05-09T10:00:00Z"),
    });

    expect(action).toBe("created");
    expect(client.createCalls.length).toBe(1);
    expect(client.updateCalls.length).toBe(0);
    expect(client.createCalls[0]?.body).toContain(COMMENT_MARKER);
    expect(client.createCalls[0]?.body).toContain("Stele Contract Report");
  });

  it("updates existing comment when its body contains the marker", async () => {
    const existing = [
      { id: 7, body: "unrelated comment" },
      { id: 11, body: `﻿\nsome leading bytes\n${COMMENT_MARKER}\nold body` },
    ];
    const client = makeClient(existing);
    const violations = [makeViolation()];

    const action = await upsertPrComment(violations, makeReport(violations), {
      client,
      context: makeContext(),
      token: "ghs_test",
    });

    expect(action).toBe("updated");
    expect(client.updateCalls.length).toBe(1);
    expect(client.updateCalls[0]?.comment_id).toBe(11);
    expect(client.createCalls.length).toBe(0);
  });

  it("uses includes() not startsWith() to find the marker", async () => {
    // Body where the marker is preceded by a BOM and a stray newline — this
    // is what mobile UIs and certain proxies sometimes produce. startsWith()
    // would miss it; includes() handles it.
    const tricky = `﻿\n${COMMENT_MARKER}\n## Stele Contract Report`;
    expect(tricky.startsWith(COMMENT_MARKER)).toBe(false);
    expect(tricky.includes(COMMENT_MARKER)).toBe(true);

    const client = makeClient([{ id: 5, body: tricky }]);
    const action = await upsertPrComment([], makeReport([]), {
      client,
      context: makeContext(),
      token: "ghs_test",
    });

    expect(action).toBe("updated");
    expect(client.updateCalls[0]?.comment_id).toBe(5);
  });

  it("skips silently when not running on a pull_request event", async () => {
    const client = makeClient();
    const action = await upsertPrComment([], makeReport([]), {
      client,
      context: makeContext({ payload: {} }),
      token: "ghs_test",
    });
    expect(action).toBe("skipped");
    expect(client.createCalls.length).toBe(0);
    expect(client.updateCalls.length).toBe(0);
  });
});

describe("renderViolation", () => {
  it("renders the witness line when failure_witness is present", () => {
    const violation = makeViolation({
      rule_id: "BALANCE_NON_NEGATIVE",
      cause: {
        summary: "forall failed at index 3",
        detail: "Account 'alice' had negative balance",
        failure_witness: {
          operator: "forall",
          collection_size: 47,
          failed_at_index: 3,
          failed_item: { account: "alice", balance: -50 },
          predicate_source: "balance >= 0",
          truncated: false,
        },
      },
    });

    const rendered = renderViolation(violation);

    expect(rendered).toContain("`BALANCE_NON_NEGATIVE`");
    expect(rendered).toContain("(error)");
    expect(rendered).toContain("**Where**: `src/example.ts` (line 12)");
    expect(rendered).toContain("**Cause**: forall failed at index 3");
    expect(rendered).toContain("**Detail**: Account 'alice' had negative balance");
    expect(rendered).toContain("**Witness**: `forall` failed at index 3 of 47");
    expect(rendered).toContain('"alice"');
  });

  it("omits witness line when failure_witness is missing", () => {
    const violation = makeViolation();
    const rendered = renderViolation(violation);
    expect(rendered).not.toContain("**Witness**");
  });

  it("uses '(no specific location)' when location.path is missing", () => {
    const violation = makeViolation({ location: {} });
    const rendered = renderViolation(violation);
    expect(rendered).toContain("**Where**: (no specific location)");
  });

  it("renders location without line when only path is set", () => {
    const violation = makeViolation({ location: { path: "src/x.ts" } });
    const rendered = renderViolation(violation);
    expect(rendered).toContain("**Where**: `src/x.ts`");
    expect(rendered).not.toContain("(line ");
  });

  it("does not include cause.detail line when detail is empty", () => {
    const violation = makeViolation({
      cause: { summary: "boom" },
    });
    const rendered = renderViolation(violation);
    expect(rendered).not.toContain("**Detail**");
  });

  it("uses real schema field names (rule_id, location.path, cause.summary)", () => {
    // Defensively pin field names by writing the wrong ones too.
    const violation = makeViolation({
      rule_id: "REAL_ID",
      location: { path: "real.ts", line: 1 },
      cause: { summary: "real summary" },
    });
    (violation as Record<string, unknown>).invariant_id = "WRONG";
    (violation.location as Record<string, unknown>).file = "wrong.ts";

    const rendered = renderViolation(violation);
    expect(rendered).toContain("REAL_ID");
    expect(rendered).toContain("real.ts");
    expect(rendered).toContain("real summary");
    expect(rendered).not.toContain("WRONG");
    expect(rendered).not.toContain("wrong.ts");
  });
});

describe("renderComment", () => {
  it("includes the marker, run link, and 'Passing' status when no violations", () => {
    const report = makeReport([]);
    const body = renderComment([], report, 99, "https://github.com/x/y/actions/runs/99", () => new Date("2026-05-09T10:00:00Z"));
    expect(body.split("\n")[0]).toBe(COMMENT_MARKER);
    expect(body).toContain("**Status**: Passing");
    expect(body).toContain("[#99](https://github.com/x/y/actions/runs/99)");
    expect(body).not.toContain("### Violations");
  });

  it("truncates to 50 violations and reports the omission count", () => {
    const violations = Array.from({ length: 55 }, (_unused, index) =>
      makeViolation({ rule_id: `R_${index}` }),
    );
    const body = renderComment(violations, makeReport(violations), 1, "https://g/r/x/runs/1", () => new Date());
    expect(body).toContain("**Status**: 55 violations");
    expect(body).toContain("5 more violations omitted from comment.");
  });
});
