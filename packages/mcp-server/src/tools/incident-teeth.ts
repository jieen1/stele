import { runIncidentTeeth } from "@stele/cli";

import type { McpResult, ToolDef } from "../types.js";
import { validateProjectDir } from "../path-validation.js";
import { sanitizeError } from "../error-sanitizer.js";

/**
 * MCP tool: incident_teeth
 *
 * Thin wrapper over @stele/cli's result-returning runIncidentTeeth. Creates two
 * isolated detached worktrees (parentSha, fixSha), runs the candidate negative
 * test in each, and writes .stele/proofs/<id>/teeth.json (scratch — never
 * hashed). Verdict TEETH_PROVEN iff the test FAILS at <fix>^ AND PASSES at <fix>.
 *
 * A TEETH_FAILED verdict is a SUCCESSFUL run reporting a negative result, so it
 * is isError:false. isError:true is reserved for infrastructure errors (missing
 * draft, unresolvable rev, absent python, worktree failure) surfaced as a reject.
 */
export function createIncidentTeethTool(): ToolDef {
  return {
    name: "incident_teeth",
    description:
      "Prove a candidate negative test FAILS at <fix>^ AND PASSES at <fix> in isolated git worktrees. Writes only to .stele/proofs/<id>/ (scratch). Returns the teeth verdict.",
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

      try {
        const result = await runIncidentTeeth(projectDir, { id });
        const text =
          `Teeth verdict: ${result.verdict}\n` +
          `  parent  exit=${result.parentRun.exit}  outputSha256=${result.parentRun.outputSha256}\n` +
          `  fix     exit=${result.fixRun.exit}  outputSha256=${result.fixRun.outputSha256}\n` +
          `  testSha256 ${result.testSha256}\n` +
          `  proof   ${result.teethPath}\n` +
          (result.verdict === "TEETH_PROVEN"
            ? `\nNext: incident_approve { id: "${id}" }`
            : `\nNot proven: revise the negative test (it must FAIL at <fix>^ AND PASS at <fix>) and re-run incident_draft.`);
        return { content: [{ type: "text", text }], isError: false };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Unable to run teeth proof: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  };
}
