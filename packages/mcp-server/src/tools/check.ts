import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { ViolationReport } from "@stele/core";
import type { CheckResult, McpResult, SessionState } from "../types.js";
import { getSessionState } from "../session-state.js";

const DEFAULT_PROJECT_DIR = process.cwd();

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
      const projectDir = resolve(args.projectDir as string ?? DEFAULT_PROJECT_DIR);
      const json = args.json !== false;
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
            isError: false,
          };
        }

        session.recordCheck({
          ok: report.ok,
          report,
          violations: report.violations ?? [],
          summary: report.summary ?? {},
        });

        if (json) {
          return {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            isError: !report.ok,
          };
        }

        const violationCount = report.violations?.length ?? 0;
        const invariantCount = report.summary?.invariantCount ?? 0;

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

/**
 * Get session state for a project.
 */
function getSessionState(projectDir: string): SessionState {
  // Dynamic import to avoid circular dependency
  const { getSessionState: get } = require("../session-state.js");
  return get(projectDir);
}
