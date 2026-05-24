// DDD generator entry point — Phase 2.1 of DDD + TypeDriven.
// Compiles design profile into Stele contract CDL declarations.

import type { DesignProfile } from "../design-profile/types.js";
import {
  renderContextArchitecture,
  renderAclIntegration,
  renderAggregateClassShape,
  renderAggregateCoreNode,
  renderAllDeclarations,
  renderTraceSection,
  renderTypeDrivenDeclarations,
} from "./render-stele.js";
import type { ProvenanceOutput, ProvenanceRule } from "./manifest.js";

// ---------------------------------------------------------------------------
// Generator result
// ---------------------------------------------------------------------------

export interface GeneratorResult {
  architectures: string[]; // CDL strings for architecture declarations
  coreNodes: string[];     // CDL strings for core-node declarations (Phase 6: class-shapes are interleaved here, immediately after their companion core-node)
  classShapes: string[];   // CDL strings for class-shape declarations emitted from aggregate roots (Phase 6)
  brandedIds: string[];    // CDL strings for branded-id declarations
  smartCtors: string[];    // CDL strings for smart-ctor declarations
  combined: string;        // All declarations concatenated
  manifest: {
    generator: string;
    profile_sha256: string;
    outputs: Array<{
      path: string;
      sha256: string;
      rule_count: number;
    }>;
  };
  provenanceOutputs: ProvenanceOutput[]; // Rule-level provenance with enforcement_level
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateFromProfile(profile: DesignProfile): GeneratorResult {
  const architectures: string[] = [];
  const coreNodes: string[] = [];
  const provenanceRules: ProvenanceRule[] = [];

  const tsconfig = profile.project?.tsconfig ?? "tsconfig.json";

  // Generate per-context architecture declarations
  if (profile.ddd?.contexts) {
    for (const ctx of profile.ddd.contexts) {
      const arch = renderContextArchitecture(ctx, tsconfig);
      architectures.push(arch);
      provenanceRules.push({
        id: `ddd-${ctx.id}`,
        kind: "architecture",
        origins: [],
        enforcement_level: "hard",
        source: "generated",
      });
    }
  }

  // Generate ACL integration architecture if integrations exist
  let aclArch: string | undefined;
  if (profile.ddd?.integrations && profile.ddd.integrations.length > 0 && profile.ddd?.contexts) {
    aclArch = renderAclIntegration(profile.ddd.contexts, profile.ddd.integrations, tsconfig);
    architectures.push(aclArch);
    provenanceRules.push({
      id: "ddd-context-map",
      kind: "architecture",
      origins: [],
      enforcement_level: "hard",
      source: "generated",
    });
  }

  // Generate core-node declarations from aggregate roots. Phase 6
  // (self-dogfooding, 2026-05-25): each aggregate root that carries
  // `required_methods` or `required_fields` also emits a paired
  // `(class-shape …)` immediately after its core-node so the structural
  // shape is locked alongside the metric bounds. The class-shape
  // evaluator (see packages/cli/src/code-shape/evaluate.ts) binds only
  // to real TypeScript `class` declarations; aggregates whose target is
  // a free function silently produce no class-shape (decision log).
  const classShapes: string[] = [];
  if (profile.ddd?.contexts) {
    for (const ctx of profile.ddd.contexts) {
      if (ctx.aggregate_roots) {
        for (const agg of ctx.aggregate_roots) {
          const cn = renderAggregateCoreNode(ctx.id, agg);
          coreNodes.push(cn);
          provenanceRules.push({
            id: `${ctx.id}-${agg.id}-aggregate`,
            kind: "core-node",
            origins: [],
            enforcement_level: "hard",
            source: "generated",
          });
          const cs = renderAggregateClassShape(ctx.id, agg);
          if (cs !== undefined) {
            // Append the class-shape immediately after the core-node in
            // the coreNodes array so the two views of the aggregate
            // stay adjacent in the generated CDL. Track it separately
            // in classShapes for the manifest rule_count + provenance.
            coreNodes.push(cs);
            classShapes.push(cs);
            provenanceRules.push({
              id: `${ctx.id}-${agg.id}-aggregate-shape`,
              kind: "class-shape",
              origins: [],
              enforcement_level: "hard",
              source: "generated",
            });
          }
        }
      }
    }
  }

  // Generate type-driven declarations (branded-id, smart-ctor)
  const typeDriven = renderTypeDrivenDeclarations(profile);
  for (const td of profile.type_driven?.branded_ids?.declarations ?? []) {
    const name = td.name ?? td.id ?? "";
    provenanceRules.push({
      id: `branded-id.${name}`,
      kind: "branded-id",
      origins: [],
      enforcement_level: (profile.type_driven?.branded_ids?.mode === "hard" ? "hard" : "partial"),
      source: "generated",
    });
  }
  for (const sc of profile.type_driven?.smart_constructors?.value_objects ?? []) {
    const name = sc.name ?? sc.id ?? "";
    provenanceRules.push({
      id: `smart-ctor.${name}`,
      kind: "smart-ctor",
      origins: [],
      enforcement_level: (profile.type_driven?.smart_constructors?.mode === "hard" ? "hard" : "partial"),
      source: "generated",
    });
  }

  let allDeclarations = renderAllDeclarations(
    architectures.filter((a) => a !== aclArch),
    aclArch,
    coreNodes,
    typeDriven.brandedIds,
    typeDriven.smartCtors,
  );

  // Append trace-policy declarations at the end. Done as a conditional
  // suffix so profiles without a `trace:` section keep byte-identical
  // output (see tests/render-stele-snapshot.test.ts).
  //
  // Provenance entries for trace-policies are intentionally NOT added
  // here: the ProvenanceRule.kind union (see manifest.ts) does not yet
  // accept "trace-policy". A later task (T3.x / manifest extension)
  // wires that in once the kind is widened.
  const traceBlock = renderTraceSection(profile.trace);
  if (traceBlock.length > 0) {
    allDeclarations = allDeclarations.length > 0
      ? `${allDeclarations}\n\n${traceBlock}`
      : traceBlock;
  }
  const tracePolicyCount = profile.trace?.policies?.length ?? 0;

  const provenanceOutputs: ProvenanceOutput[] = [
    {
      path: "contract/generated/ddd-typedriven.stele",
      sha256: "", // Computed by caller
      rules: provenanceRules,
    },
  ];

  return {
    architectures,
    coreNodes,
    classShapes,
    brandedIds: typeDriven.brandedIds,
    smartCtors: typeDriven.smartCtors,
    combined: allDeclarations,
    manifest: {
      generator: "@stele/cli",
      profile_sha256: "", // Computed by caller
      outputs: [
        {
          path: "contract/generated/ddd-typedriven.stele",
          sha256: "", // Computed by caller
          rule_count: architectures.length + coreNodes.length + typeDriven.brandedIds.length + typeDriven.smartCtors.length + tracePolicyCount,
        },
      ],
    },
    provenanceOutputs,
  };
}
