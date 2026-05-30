import { createCheckTool } from "./check.js";
import { createStatusTool } from "./status.js";
import { createListContractsTool } from "./list-contracts.js";
import { createContextTool } from "./context.js";
import { createValidateEditTool } from "./validate-edit.js";
import { createCheckSessionTool } from "./check-session.js";
import { createExplainViolationTool } from "./explain-violation.js";
import { createWhyTool } from "./why.js";
import { createProposeContractTool } from "./propose-contract.js";
import { createObserveTool } from "./observe.js";
import { createIncidentDraftTool } from "./incident-draft.js";
import { createIncidentTeethTool } from "./incident-teeth.js";
import { createIncidentApproveTool } from "./incident-approve.js";
import type { ToolDef } from "../types.js";

/**
 * Registry of all MCP tools.
 *
 * Tools are registered with the MCP server in `server.ts`.
 * New tools should be added to this array and the corresponding
 * module should export a `create<Tool>Tool` function returning
 * `{ name, description, inputSchema, handler }`.
 */
export function registerTools(): ToolDef[] {
  return [
    createCheckTool(),
    createStatusTool(),
    createListContractsTool(),
    createContextTool(),
    createValidateEditTool(),
    createCheckSessionTool(),
    createExplainViolationTool(),
    createWhyTool(),
    createProposeContractTool(),
    createObserveTool(),
    createIncidentDraftTool(),
    createIncidentTeethTool(),
    createIncidentApproveTool(),
  ];
}
