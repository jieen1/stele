// DDD generator entry point — Phase 2.1 of DDD + TypeDriven.
// Compiles design profile into Stele contract CDL declarations.

import type { DesignProfile } from "../design-profile/types.js";
import {
  renderContextArchitecture,
  renderAclIntegration,
  renderAggregateCoreNode,
  renderAllDeclarations,
} from "./render-stele.js";
import type { ProvenanceOutput, ProvenanceRule } from "./manifest.js";

// ---------------------------------------------------------------------------
// Generator result
// ---------------------------------------------------------------------------

export interface GeneratorResult {
  architectures: string[]; // CDL strings for architecture declarations
  coreNodes: string[];     // CDL strings for core-node declarations
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

  // Generate core-node declarations from aggregate roots
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
        }
      }
    }
  }

  const allDeclarations = renderAllDeclarations(
    architectures.filter((a) => a !== aclArch),
    aclArch,
    coreNodes,
  );

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
    combined: allDeclarations,
    manifest: {
      generator: "@stele/cli",
      profile_sha256: "", // Computed by caller
      outputs: [
        {
          path: "contract/generated/ddd-typedriven.stele",
          sha256: "", // Computed by caller
          rule_count: architectures.length + coreNodes.length,
        },
      ],
    },
    provenanceOutputs,
  };
}
