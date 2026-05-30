import { runIncidentApprove } from "@stele/cli";

import type { McpResult, ToolDef } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { sanitizeError } from "../error-sanitizer.js";

/**
 * MCP tool: incident_approve
 *
 * Thin wrapper over @stele/cli's result-returning runIncidentApprove. Enforces
 * the teeth hard gate (TEETH_PROVEN, OR --teeth-unavailable-reason which records
 * teeth:unproven; TEETH_FAILED always refuses), then atomically applies the
 * provenance-tagged invariant (apply→generate→lock with rollback) and writes a
 * signed approval record under scratch.
 *
 * A refusal maps to isError:true with the refusal reason. There is NO new
 * numeric exit code (C4): refusals never invent an exit code. Success leaves the
 * repo at stele-check exit-0.
 */
export function createIncidentApproveTool(): ToolDef {
  return {
    name: "incident_approve",
    description:
      "Approve an incident: enforce the teeth gate, then atomically apply→generate→lock the provenance-tagged invariant and write a signed approval record. Refuses (isError) on TEETH_FAILED or an unproven teeth state without a reason.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        id: {
          type: "string",
          description: "Incident id (from incident_draft)",
        },
        approvedBy: {
          type: "string",
          description: "Human-identifying approver token (email or scoped id)",
        },
        teethUnavailableReason: {
          type: "string",
          description:
            "Approve as teeth:unproven when no TEETH_PROVEN proof exists (records the reason). Cannot override a TEETH_FAILED verdict.",
        },
      },
      required: ["id"],
    },
    handler: async (args: Record<string, unknown>): Promise<McpResult> => {
      const resolved = validateProjectDir(args.projectDir);
      if ("error" in resolved) {
        return { content: [{ type: "text", text: resolved.error }], isError: true };
      }
      const projectDir = resolved.path;
      const id = String(args.id ?? "");
      const approvedBy = typeof args.approvedBy === "string" ? args.approvedBy : undefined;
      const teethUnavailableReason =
        typeof args.teethUnavailableReason === "string" ? args.teethUnavailableReason : undefined;

      try {
        const result = await runIncidentApprove(projectDir, {
          id,
          approvedBy,
          teethUnavailableReason,
        });

        if (result.refused) {
          return {
            content: [
              {
                type: "text",
                text: `Approval refused: ${result.reason ?? "teeth gate not satisfied"}`,
              },
            ],
            isError: true,
          };
        }

        const text =
          `Approved incident ${id}.\n` +
          `  tags        ${result.tagsApplied.join(" ")}\n` +
          `  approval    ${result.approvalRecordPath}\n` +
          `  repo at stele check exit-0`;
        return { content: [{ type: "text", text }], isError: false };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Unable to approve incident: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  };
}
