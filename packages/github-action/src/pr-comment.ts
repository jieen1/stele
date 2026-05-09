import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Violation, ViolationReport } from "@stele/core";

export const COMMENT_MARKER = "<!-- stele-report:v1 -->";
export const ACTION_VERSION = "0.1.0";

const MAX_VIOLATIONS_IN_COMMENT = 50;
const MAX_WITNESS_ITEM_CHARS = 80;

/** Minimal Octokit shape we depend on; lets tests inject a stub. */
export interface CommentClient {
  paginate: (
    fn: unknown,
    parameters: { owner: string; repo: string; issue_number: number },
  ) => Promise<Array<{ id: number; body?: string }>>;
  rest: {
    issues: {
      listComments: unknown;
      updateComment: (parameters: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<unknown>;
      createComment: (parameters: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
    };
  };
}

export interface CommentContext {
  payload: { pull_request?: { number: number } };
  repo: { owner: string; repo: string };
  runId: number;
  serverUrl: string;
}

export interface UpsertOptions {
  client?: CommentClient;
  context?: CommentContext;
  now?: () => Date;
  /** Used by tests to bypass `core.getInput("token")`. */
  token?: string;
}

/**
 * Upsert a single PR comment containing the violation report. Reuses an
 * existing comment whose body contains `COMMENT_MARKER`; otherwise creates a
 * new one. No-op when the action is not running on a `pull_request` event.
 */
export async function upsertPrComment(
  violations: Violation[],
  report: ViolationReport,
  options: UpsertOptions = {},
): Promise<"created" | "updated" | "skipped"> {
  const ctx = options.context ?? buildContextFromGithub();
  if (!ctx.payload.pull_request) {
    return "skipped";
  }

  const client = options.client ?? buildClientFromInput(options.token);
  const owner = ctx.repo.owner;
  const repo = ctx.repo.repo;
  const issueNumber = ctx.payload.pull_request.number;

  const existing = await client.paginate(client.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
  });

  // Use `body.includes` not `startsWith` — survives BOM, mobile UI prepended
  // newlines, or anything else that may shift our marker off the first byte.
  const marker = existing.find((comment) => comment.body?.includes(COMMENT_MARKER));

  const body = renderComment(violations, report, ctx.runId, runUrl(ctx), options.now ?? (() => new Date()));

  if (marker) {
    await client.rest.issues.updateComment({
      owner,
      repo,
      comment_id: marker.id,
      body,
    });
    return "updated";
  }

  await client.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
  return "created";
}

export function renderComment(
  violations: Violation[],
  report: ViolationReport,
  runId: number,
  runHref: string,
  now: () => Date,
): string {
  const totalActive = violations.length;
  const status =
    totalActive === 0
      ? "Passing"
      : `${totalActive} violation${totalActive === 1 ? "" : "s"}`;

  const lines: string[] = [
    COMMENT_MARKER,
    "## Stele Contract Report",
    "",
    `**Status**: ${status} | **Run**: [#${runId}](${runHref})`,
    "",
  ];

  if (totalActive > 0) {
    lines.push("### Violations", "");
    for (const violation of violations.slice(0, MAX_VIOLATIONS_IN_COMMENT)) {
      lines.push(renderViolation(violation));
    }
    if (totalActive > MAX_VIOLATIONS_IN_COMMENT) {
      lines.push(
        "",
        `_${totalActive - MAX_VIOLATIONS_IN_COMMENT} more violations omitted from comment._`,
      );
    }
  }

  const summary = report.summary;
  if (summary && (summary.suppressed_violation_count || summary.out_of_scope_violation_count)) {
    lines.push(
      "",
      `_Suppressed: ${summary.suppressed_violation_count ?? 0} | Out of scope: ${summary.out_of_scope_violation_count ?? 0}_`,
    );
  }

  lines.push(
    "",
    "---",
    `*This comment auto-updates on every push. Generated at ${now().toISOString()} by \`@stele/github-action@${ACTION_VERSION}\`.*`,
  );
  return lines.join("\n");
}

export function renderViolation(v: Violation): string {
  // Real schema (cli-output.md §2): rule_id (NOT invariant_id),
  // location.path (NOT location.file), cause.summary + cause.detail (NOT
  // cause.kind), cause.failure_witness sibling field.
  const witness = v.cause.failure_witness;
  const witnessLine = witness
    ? `- **Witness**: \`${witness.operator}\` failed at index ${witness.failed_at_index ?? "?"} of ${witness.collection_size}, item: \`${truncate(JSON.stringify(witness.failed_item), MAX_WITNESS_ITEM_CHARS)}\``
    : "";
  const where = v.location?.path
    ? `\`${v.location.path}\`${v.location.line ? ` (line ${v.location.line})` : ""}`
    : "(no specific location)";

  return [
    `#### \`${v.rule_id}\` (${v.severity})`,
    `- **Where**: ${where}`,
    `- **Cause**: ${v.cause.summary}`,
    v.cause.detail ? `- **Detail**: ${v.cause.detail}` : "",
    witnessLine,
    "- **Suppress**: `npx stele baseline-update --reason \"...\"`",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function truncate(value: string | undefined, max: number): string {
  if (value === undefined) return "undefined";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function runUrl(ctx: CommentContext): string {
  return `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${ctx.runId}`;
}

function buildContextFromGithub(): CommentContext {
  const ctx = github.context;
  return {
    payload: ctx.payload as { pull_request?: { number: number } },
    repo: { owner: ctx.repo.owner, repo: ctx.repo.repo },
    runId: ctx.runId,
    serverUrl: ctx.serverUrl ?? "https://github.com",
  };
}

function buildClientFromInput(tokenOverride: string | undefined): CommentClient {
  const token = tokenOverride ?? core.getInput("token");
  if (!token) {
    throw new Error(
      "Missing `token` input. Pass `token: ${{ secrets.GITHUB_TOKEN }}` to the Action.",
    );
  }
  return github.getOctokit(token) as unknown as CommentClient;
}
