import { execFileSync } from "node:child_process";
import type { ViolationReport } from "@stele/core";
import type { CheckResult, McpResult } from "../types.js";
import { toReportSummary } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { getSessionState, readMaterialObservations } from "../session-state.js";
import { loadProjectState } from "../contract-cache.js";

/**
 * MCP tool: stele-check-session
 *
 * Full session check — equivalent to `stele check` + maintenance review.
 * Used at session end to verify all invariants and request
 * maintenance review if material changes were observed.
 */
export function createCheckSessionTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => McpResult;
} {
  return {
    name: "stele-check-session",
    description:
      "Full session check. Runs stele check and requests maintenance review if material changes were observed.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        json: {
          type: "boolean",
          description: "Return JSON report (default: true)",
          default: true,
        },
      },
      required: [],
    },
    handler: (args: Record<string, unknown>): McpResult => {
      const validated = validateProjectDir(args.projectDir);
      if (validated.error) {
        return {
          content: [{ type: "text", text: validated.error }],
          isError: true,
        };
      }
      const projectDir = validated.path!;
      const json = args.json !== false;
      const session = getSessionState(projectDir);
      const materialObservations = readMaterialObservations(projectDir);

      try {
        // Run stele check
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
          summary: toReportSummary(report.summary),
        });

        // Check if maintenance review is needed
        const needsReview = materialObservations.length > 0;

        if (json) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    check: report,
                    maintenanceReview: needsReview
                      ? {
                          required: true,
                          materialObservations: materialObservations.length,
                          guidance: "Material source edits were observed. Review .stele/maintenance/summary.md and add new invariants if learned durable project behavior.",
                        }
                      : { required: false },
                  },
                  null,
                  2
                ),
              },
            ],
            isError: !report.ok || needsReview,
          };
        }

        const violationCount = report.violations?.length ?? 0;
        let summary = report.ok
          ? `Stele session check: PASS\n- Invariants checked: ${report.summary?.invariant_count ?? 0}\n- Violations: ${violationCount}`
          : `Stele session check: FAIL\n- Invariants checked: ${report.summary?.invariant_count ?? 0}\n- Violations: ${violationCount}`;

        if (needsReview) {
          summary += `\n\n⚠️ Maintenance review required: ${materialObservations.length} material observation(s) detected.`;
        }

        return {
          content: [{ type: "text", text: summary }],
          isError: !report.ok || needsReview,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `stele check-session failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
