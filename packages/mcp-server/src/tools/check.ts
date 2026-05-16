import { execFileSync } from "node:child_process";
import type { ViolationReport } from "@stele/core";
import type { CheckResult, McpResult } from "../types.js";
import { toReportSummary } from "../types.js";
import { getSessionState, type SessionState } from "../session-state.js";
import { validateProjectDir } from "../path-validation.js";

/**
 * MCP tool: stele-check
 *
 * Run `stele check` on a project directory to verify contract compliance.
 * Uses the CLI directly for full verification (manifest + generated tests).
 */
export function createCheckTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-check",
    description:
      "Run stele check on a project directory to verify contract compliance. Returns JSON violation report.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory (defaults to current working directory)",
        },
        json: {
          type: "boolean",
          description: "Return JSON violation report (default: true)",
          default: true,
        },
      },
      required: [],
    },
    handler: (args: Record<string, unknown>): McpResult => {
      const result = validateProjectDir(args.projectDir);
      const json = args.json !== false;
      if (result.error) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }
      const projectDir = result.path!;
      const session = getSessionState(projectDir);

      try {
        const output = execFileSync("npx", ["stele", "check", ...(json ? ["--json"] : [])], {
          cwd: projectDir,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        });

        let report: ViolationReport;

        try {
          report = JSON.parse(output);
        } catch {
          return {
            content: [{ type: "text", text: output }],
            isError: true,
          };
        }

        session.recordCheck({
          ok: report.ok,
          report,
          violations: report.violations ?? [],
          summary: toReportSummary(report.summary),
        });

        if (json) {
          return {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            isError: !report.ok,
          };
        }

        const violationCount = report.violations?.length ?? 0;
        const invariantCount = report.summary?.invariant_count ?? 0;

        return {
          content: [
            {
              type: "text",
              text: `Stele check result: ${report.ok ? "PASS" : "FAIL"}\n` +
                `- Invariants checked: ${invariantCount}\n` +
                `- Violations: ${violationCount}\n` +
                (violationCount > 0
                  ? `\nViolations:\n${report.violations?.map((v) => `  - ${v.rule_id}: ${v.cause.summary}`).join("\n")}`
                  : ""),
            },
          ],
          isError: !report.ok,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `stele check failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
