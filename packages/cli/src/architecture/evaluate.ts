import { evaluateArchitecture } from "@stele/architecture-core";
import type { ArchitectureDeclaration, ArchitectureGraph, DependencyViolation, CycleViolation } from "@stele/architecture-core";
import { createViolation } from "@stele/core";
import type { Violation } from "@stele/core";

/**
 * Evaluate an architecture declaration against a dependency graph.
 *
 * Converts architecture-core violations into Stele Violation objects.
 */
export function evaluateArchitectureDeclaration(
  declaration: ArchitectureDeclaration,
  graph: ArchitectureGraph,
  command: string,
): Violation[] {
  const result = evaluateArchitecture(declaration, graph);
  const violations: Violation[] = [];

  // Dependency direction violations
  for (const violation of result.violations) {
    violations.push(createViolation({
      rule_id: declaration.id,
      rule_kind: "architecture_dependency",
      severity: "error",
      source: { tool: "stele", command, kind: "architecture" },
      location: { path: violation.fromFile, line: violation.line, column: violation.column },
      cause: {
        summary: `Module "${violation.fromModule}" may not depend on "${violation.toModule}".`,
        detail: `Import "${violation.specifier}" creates ${violation.fromModule} -> ${violation.toModule}, but allowed targets are: ${violation.allowedTargets.join(", ") || "<none>"}.`,
      },
      scope_paths: [violation.fromFile],
      fix: {
        summary: declaration.fix ?? "Move the dependency behind an allowed module boundary, or ask the user to approve an architecture contract change.",
      },
    }));
  }

  // Cycle violations
  for (const cycle of result.cycleViolations) {
    violations.push(createViolation({
      rule_id: declaration.id,
      rule_kind: "architecture_cycle",
      severity: "error",
      source: { tool: "stele", command, kind: "architecture" },
      location: { path: cycle.edgeFiles[0] },
      cause: {
        summary: `Dependency cycle detected: ${cycle.modules.join(" -> ")}`,
      },
      scope_paths: cycle.edgeFiles,
      fix: {
        summary: "Break the cycle by reorganizing dependencies or adding an abstraction layer.",
      },
    }));
  }

  return violations;
}
