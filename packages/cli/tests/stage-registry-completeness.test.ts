import { describe, expect, it } from "vitest";
import {
  CHECK_STAGES,
  topologicalSortStages,
  type CheckStage,
} from "../src/commands/check-stages-registry.js";
import type { ViolationReport } from "@stele/core";
import type {
  PreparedCheckContext,
  ProtectedCheckState,
} from "../src/architecture/types.js";

/**
 * Required stage IDs by layer.
 *
 *   STAGES_ALWAYS — must always be present in `CHECK_STAGES`. Covers
 *     everything shipped through v0.2 + Phase A + the parts of Phase B that
 *     have already landed (T3.3 adds "trace"; T4.4 adds "type-state";
 *     T5.4 adds "effect").
 *   STAGES_PHASE_B_ONLY — empty now that the full Phase B stage set has
 *     landed; retained as a hook for future phase gating.
 */
const STAGES_ALWAYS: readonly string[] = [
  "generated",
  "protected",
  "toolchain",
  "code-shape",
  "design",
  "architecture",
  "complexity",
  "type-driven",
  "trace",
  "type-state",
  "effect",
];
const STAGES_PHASE_B_ONLY: readonly string[] = [];

describe("CHECK_STAGES registry completeness", () => {
  it("contains all always-on stage IDs (v0.2 + phase-a + trace)", () => {
    const ids = CHECK_STAGES.map((s) => s.id);
    for (const required of STAGES_ALWAYS) {
      expect(ids).toContain(required);
    }
  });

  it("contains phase-b stage IDs when STELE_PHASE=phase-b", () => {
    if (process.env.STELE_PHASE !== "phase-b") {
      return; // skipped until T4/T5 land
    }
    const ids = CHECK_STAGES.map((s) => s.id);
    for (const required of [...STAGES_ALWAYS, ...STAGES_PHASE_B_ONLY]) {
      expect(ids).toContain(required);
    }
  });

  it("has no duplicate stage IDs", () => {
    const ids = CHECK_STAGES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dependsOn references are all valid stage IDs", () => {
    const ids = new Set(CHECK_STAGES.map((s) => s.id));
    for (const stage of CHECK_STAGES) {
      for (const dep of stage.dependsOn ?? []) {
        expect(ids).toContain(dep);
      }
    }
  });

  it("topological sort produces deterministic output", () => {
    const first = topologicalSortStages(CHECK_STAGES).map((s) => s.id);
    const second = topologicalSortStages(CHECK_STAGES).map((s) => s.id);
    expect(first).toEqual(second);
  });

  it("topological sort respects dependsOn ordering", () => {
    const ordered = topologicalSortStages(CHECK_STAGES);
    const idToPosition = new Map<string, number>();
    ordered.forEach((stage, index) => idToPosition.set(stage.id, index));
    for (const stage of ordered) {
      for (const dep of stage.dependsOn ?? []) {
        const depPos = idToPosition.get(dep);
        const ownPos = idToPosition.get(stage.id);
        expect(depPos).toBeDefined();
        expect(ownPos).toBeDefined();
        expect(depPos as number).toBeLessThan(ownPos as number);
      }
    }
  });

  it("topological sort throws on cycles", () => {
    const empty: ViolationReport = {
      tool: "stele",
      command: "check",
      ok: true,
      summary: { violation_count: 0 },
      violations: [],
      notices: [],
    } as unknown as ViolationReport;
    const cyclic: CheckStage[] = [
      {
        id: "A",
        description: "node A",
        dependsOn: ["B"],
        shouldRun: () => true,
        build: () => empty,
      },
      {
        id: "B",
        description: "node B",
        dependsOn: ["A"],
        shouldRun: () => true,
        build: () => empty,
      },
    ];
    expect(() => topologicalSortStages(cyclic)).toThrow(/cycle/i);
  });

  it("CHECK_STAGES is frozen", () => {
    expect(Object.isFrozen(CHECK_STAGES)).toBe(true);
  });
});

describe("CHECK_STAGES smoke — shouldRun gating", () => {
  function makeContext(overrides: Partial<PreparedCheckContext["contract"]> = {}): PreparedCheckContext {
    return {
      projectDir: "/tmp/stele-stage-smoke",
      config: {} as unknown as PreparedCheckContext["config"],
      contract: {
        codeShapes: [],
        brandedIds: [],
        smartCtors: [],
        tracePolicies: [],
        typeStates: [],
        typeStateBindings: [],
        effectDeclarations: [],
        effectAnnotations: [],
        effectPolicies: [],
        effectSuppressions: [],
    externAliases: [],
        ...overrides,
      } as unknown as PreparedCheckContext["contract"],
      generated: { ok: true, files: [] } as unknown as PreparedCheckContext["generated"],
      invariantCount: 0,
    };
  }

  it("code-shape only runs when contract has codeShapes", () => {
    const stage = CHECK_STAGES.find((s) => s.id === "code-shape");
    expect(stage).toBeDefined();
    expect(stage?.shouldRun(makeContext(), {})).toBe(false);
    expect(stage?.shouldRun(makeContext({ codeShapes: [{}] as unknown as PreparedCheckContext["contract"]["codeShapes"] }), {})).toBe(true);
  });

  it("type-driven runs when brandedIds OR smartCtors present", () => {
    const stage = CHECK_STAGES.find((s) => s.id === "type-driven");
    expect(stage).toBeDefined();
    expect(stage?.shouldRun(makeContext(), {})).toBe(false);
    expect(stage?.shouldRun(makeContext({ brandedIds: [{}] as unknown as PreparedCheckContext["contract"]["brandedIds"] }), {})).toBe(true);
    expect(stage?.shouldRun(makeContext({ smartCtors: [{}] as unknown as PreparedCheckContext["contract"]["smartCtors"] }), {})).toBe(true);
  });

  it("generated, protected, toolchain, architecture, complexity always run", () => {
    const alwaysOn = new Set(["generated", "protected", "toolchain", "architecture", "complexity"]);
    for (const stage of CHECK_STAGES) {
      if (alwaysOn.has(stage.id)) {
        expect(stage.shouldRun(makeContext(), {})).toBe(true);
      }
    }
  });
});

describe("CHECK_STAGES smoke — declaration order matches spec", () => {
  it("stage IDs are in the declared order", () => {
    const ids = CHECK_STAGES.map((s) => s.id);
    expect(ids).toEqual([
      "generated",
      "protected",
      "code-shape",
      "design",
      "toolchain",
      "architecture",
      "complexity",
      "type-driven",
      "trace",
      "type-state",
      "effect",
    ]);
  });

  it("topological order keeps protected after generated", () => {
    const ordered = topologicalSortStages(CHECK_STAGES).map((s) => s.id);
    expect(ordered.indexOf("generated")).toBeLessThan(ordered.indexOf("protected"));
  });

  it("runAllStages exposes a callable signature", async () => {
    const { runAllStages } = await import("../src/commands/check-stages-registry.js");
    // The smoke test does not actually invoke the runner against a real project;
    // we only assert the export is a function so a bad refactor surfaces here.
    expect(typeof runAllStages).toBe("function");
  });
});

// Hint to test reader: ProtectedCheckState is intentionally only referenced
// here so the type import is exercised by tsc when the file is type-checked.
const _protectedStateTypeProbe: ProtectedCheckState | undefined = undefined;
void _protectedStateTypeProbe;
