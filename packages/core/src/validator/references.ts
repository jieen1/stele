import { SteleError } from "../errors/SteleError.js";
import type { Contract } from "./structure.js";

export function validateReferences(contract: Contract): Contract {
  const checkerIds = new Set(contract.checkers.map((checker) => checker.id));
  const invariantIds = new Set(contract.invariants.map((invariant) => invariant.id));
  const scenarioIds = new Set(contract.scenarios.map((scenario) => scenario.id));

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

  return contract;
}
