import { runIncidentDraft } from "@stele/cli";

import type { McpResult, ToolDef } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { sanitizeError } from "../error-sanitizer.js";

/**
 * MCP tool: incident_draft
 *
 * Thin wrapper over @stele/cli's result-returning runIncidentDraft. Reads the
 * agent-supplied draft (--draft-from path/stdin on the CLI; here a path) for the
 * incident, derives/validates the id, resolves <fix>+<fix>^, dry-run compiles the
 * invariantCdl, and writes ONLY to .stele/incident/<id>/ (scratch — never hashed).
 *
 * Unlike the other MCP tools this calls the CLI lib directly (no runStele
 * shell-out): the brief mandates a deterministic, in-process lib call so the
 * whole incident wedge stays hard-testable.
 */
export function createIncidentDraftTool(): ToolDef {
  return {
    name: "incident_draft",
    description:
      "Draft a candidate contract invariant + negative test from an injected draft for an incident. Compiles the invariant dry-run and writes only to .stele/incident/<id>/ (scratch). No protected path is written.",
    inputSchema: {
      type: "object",
      properties: {
        projectDir: {
          type: "string",
          description: "Path to the project directory",
        },
        intent: {
          type: "string",
          description: "One-sentence description of the incident",
        },
        fix: {
          type: "string",
          description: "Git revision of the fix commit (the parent <fix>^ is the broken state)",
        },
        draftFrom: {
          type: "string",
          description:
            "Path to the draft JSON ({invariantCdl,negativeTest,testFilename?}). The injected bring-your-own-model seam.",
        },
        id: {
          type: "string",
          description: "Optional incident id (defaults to a slug derived from intent)",
        },
      },
      required: ["intent", "fix", "draftFrom"],
    },
    handler: async (args: Record<string, unknown>): Promise<McpResult> => {
      const resolved = validateProjectDir(args.projectDir);
      if ("error" in resolved) {
        return { content: [{ type: "text", text: resolved.error }], isError: true };
      }
      const projectDir = resolved.path;
      const intent = String(args.intent ?? "");
      const fix = String(args.fix ?? "");
      const draftFrom = String(args.draftFrom ?? "");
      const id = typeof args.id === "string" ? args.id : undefined;

      try {
        const result = await runIncidentDraft(projectDir, { intent, fix, draftFrom, id });
        if (!result.dryRun.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Draft dry-run failed: ${result.dryRun.message ?? "invariantCdl did not compile"}`,
              },
            ],
            isError: true,
          };
        }
        const text =
          `Proposed invariant (dry-run OK):\n\n${result.proposedInvariantBlock}\n\n` +
          `incident id: ${result.id}\n` +
          `fix:         ${result.fixSha}\n` +
          `parent (^):  ${result.parentSha}\n` +
          `draft.json:  ${result.draftPath}\n\n` +
          `Next: incident_teeth { id: "${result.id}" }`;
        return { content: [{ type: "text", text }], isError: false };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Unable to draft incident: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  };
}
