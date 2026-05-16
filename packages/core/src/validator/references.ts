import { SteleError } from "../errors/SteleError.js";
import type { SourceSpan } from "../ast/types.js";
import type { Contract, ContractWarning } from "./structure-types.js";

/**
 * Detect overlapping allowed and denied paths.
 * Uses simple prefix matching — full glob overlap detection is not attempted.
 * The enforcement layer already resolves conflicts (deny takes precedence).
 */
export function findPathOverlaps(allowedPaths: string[], deniedPaths: string[]): string[] {
  const overlaps: string[] = [];
  for (const allowed of allowedPaths) {
    for (const denied of deniedPaths) {
      if (allowed === denied || allowed.startsWith(denied.replace(/\*\*/g, "")) || denied.startsWith(allowed.replace(/\*\*/g, ""))) {
        overlaps.push(`"${allowed}" / "${denied}"`);
      }
    }
  }
  return overlaps;
}

export function validateReferences(contract: Contract): Contract {
  const warnings: ContractWarning[] = [];
  const checkerIds = new Set(contract.checkers.map((checker) => checker.id));
  const invariantIds = new Set(contract.invariants.map((invariant) => invariant.id));
  const scenarioIds = new Set(contract.scenarios.map((scenario) => scenario.id));
  const agentIds = new Set(contract.agents.map((agent) => agent.id));

  for (const invariant of contract.invariants) {
    if (invariant.usesChecker !== undefined && !checkerIds.has(invariant.usesChecker.checkerId)) {
      throw new SteleError(
        "E0307",
        "Validation Error",
        `Unknown checker "${invariant.usesChecker.checkerId}".`,
        invariant.usesChecker.span,
        `Invariant "${invariant.id}" references a checker that was not declared in the loaded contract files.`,
        "Declare the checker before using it or fix the checker id.",
      );
    }

    for (const dependency of invariant.dependsOn) {
      if (!invariantIds.has(dependency.id)) {
        throw new SteleError(
          "E0308",
          "Validation Error",
          `Unknown invariant dependency "${dependency.id}".`,
          dependency.span,
          `Invariant "${invariant.id}" depends on an id that does not exist in the loaded contract files.`,
          "Declare the dependency invariant or remove the depends-on entry.",
        );
      }
    }

    if (invariant.usesScenario !== undefined && !scenarioIds.has(invariant.usesScenario.scenarioId)) {
      throw new SteleError(
        "E0316",
        "Validation Error",
        `Unknown scenario "${invariant.usesScenario.scenarioId}".`,
        invariant.usesScenario.span,
        `Invariant "${invariant.id}" references a scenario that was not declared in the loaded contract files.`,
        "Declare the scenario before using it or fix the scenario id.",
      );
    }
  }

  // -- Agent cross-reference validation --

  for (const scope of contract.scopes) {
    if (!agentIds.has(scope.agentId)) {
      throw new SteleError(
        "E0320",
        "Validation Error",
        `Unknown agent "${scope.agentId}" in scope declaration.`,
        scope.span,
        `Scope references agent "${scope.agentId}" which was not declared in the loaded contract files.`,
        "Declare the agent before referencing it in a scope, or fix the agent id.",
      );
    }
  }

  for (const interAgentContract of contract.interAgentContracts) {
    for (const agentId of interAgentContract.agents) {
      if (!agentIds.has(agentId)) {
        throw new SteleError(
          "E0320",
          "Validation Error",
          `Unknown agent "${agentId}" in inter-agent contract "${interAgentContract.id}".`,
          interAgentContract.span,
          `Inter-agent contract "${interAgentContract.id}" references agent "${agentId}" which was not declared.`,
          "Declare the agent before referencing it in a contract, or fix the agent id.",
        );
      }
    }

    for (const req of interAgentContract.requires) {
      if (!agentIds.has(req.agentId)) {
        throw new SteleError(
          "E0320",
          "Validation Error",
          `Unknown agent "${req.agentId}" in requires clause of contract "${interAgentContract.id}".`,
          req.span,
          `Requires clause references agent "${req.agentId}" which was not declared.`,
          "Declare the agent before referencing it, or fix the agent id.",
        );
      }

      if (!agentIds.has(req.approvedBy)) {
        throw new SteleError(
          "E0320",
          "Validation Error",
          `Unknown approver "${req.approvedBy}" in requires clause of contract "${interAgentContract.id}".`,
          req.span,
          `Requires clause references approver "${req.approvedBy}" which was not declared.`,
          "Declare the approver agent, or fix the agent id.",
        );
      }

      if (req.agentId === req.approvedBy) {
        throw new SteleError(
          "E0320",
          "Validation Error",
          `Agent "${req.agentId}" cannot approve its own changes in contract "${interAgentContract.id}".`,
          req.span,
          "An agent approving its own changes provides no safety guarantee.",
          "Use a different agent as the approver.",
        );
      }
    }
  }

  for (const conflict of contract.conflicts) {
    for (const agentId of conflict.agents) {
      if (!agentIds.has(agentId)) {
        throw new SteleError(
          "E0320",
          "Validation Error",
          `Unknown agent "${agentId}" in conflict declaration for "${conflict.path}".`,
          conflict.span,
          `Conflict declaration references agent "${agentId}" which was not declared.`,
          "Declare the agent before referencing it in a conflict, or fix the agent id.",
        );
      }
    }
  }

  // -- Agent path safety validation --

  for (const agent of contract.agents) {
    for (const path of agent.allowedPaths) {
      validateAgentPath(path, agent.span, `Agent "${agent.id}" allowed-paths`);
    }
    for (const path of agent.deniedPaths) {
      validateAgentPath(path, agent.span, `Agent "${agent.id}" denied-paths`);
    }
    const overlaps = findPathOverlaps(agent.allowedPaths, agent.deniedPaths);
    if (overlaps.length > 0) {
      warnings.push({ type: "path-overlap", agentId: agent.id, overlaps });
    }
  }

  for (const scope of contract.scopes) {
    for (const path of scope.paths) {
      validateAgentPath(path, scope.span, `Scope "${scope.agentId}" paths`);
    }
  }

  for (const interAgentContract of contract.interAgentContracts) {
    for (const req of interAgentContract.requires) {
      validateAgentPath(req.pathPattern, req.span, `Requires clause in contract "${interAgentContract.id}"`);
    }
  }

  for (const conflict of contract.conflicts) {
    validateAgentPath(conflict.path, conflict.span, `Conflict declaration for "${conflict.path}"`);
  }

  contract.warnings = warnings;
  return contract;
}

function validateAgentPath(path: string, span: SourceSpan, label: string): void {
  if (path === "") {
    throw new SteleError(
      "E0322",
      "Validation Error",
      `${label} contains an empty path.`,
      span,
      "Agent paths must be non-empty glob patterns.",
      "Provide a valid glob pattern such as \"src/**\".",
    );
  }

  if (path.startsWith("/") || /^[a-zA-Z]:\//.test(path)) {
    throw new SteleError(
      "E0322",
      "Validation Error",
      `${label} contains an absolute path: "${path}".`,
      span,
      "Agent paths must be relative glob patterns, not absolute paths.",
      "Use a relative glob pattern such as \"src/**\".",
    );
  }

  const segments = path.split("/").filter((seg) => seg.length > 0);
  for (const segment of segments) {
    if (segment === "..") {
      throw new SteleError(
        "E0322",
        "Validation Error",
        `${label} contains a path traversal segment in "${path}".`,
        span,
        "Agent paths must not contain '..' segments (path traversal).",
        "Use a relative glob pattern without '..' segments.",
      );
    }
  }
}
