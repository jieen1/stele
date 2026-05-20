import { minimatch } from "minimatch";
import { resolve } from "node:path";
import {
  loadConfig,
} from "../config/loadConfig.js";
import {
  loadContract,
  type ArchitectureDeclaration,
  type ArchitectureModuleDeclaration,
  type Contract,
  type CoreNodeDeclaration,
} from "@stele/core";
import { buildRuleIndex, type IndexedCodeShape, type IndexedRule, type RuleIndex } from "./rules.js";
import { readManifest, type StructuredOrigin } from "../design-generator/manifest.js";

export type AgentContextOptions = {
  json?: boolean;
  focus?: string[];
};

export type ArchitectureContextEntry = {
  architecture_id: string;
  module_id: string;
  allowed_dependencies: string[];
  deny_cycles: boolean;
};

export type GeneratedRuleSource = {
  rule_id: string;
  profile_anchor: string;
  decision_id: string;
  enforcement_level: "hard" | "partial" | "advisory";
};

export type AgentContext = {
  schema_version: "1";
  policy: {
    source_first: string;
    add_rule: string;
    modify_delete: string;
    lock: string;
  };
  protected: string[];
  focus: string[];
  relevant_rules: IndexedRule[];
  relevant_code_shapes: IndexedCodeShape[];
  architecture_context: ArchitectureContextEntry[];
  architectures: ArchitectureDeclaration[];
  coreNodes: CoreNodeDeclaration[];
  summary: RuleIndex["summary"];
  generated_rule_sources?: GeneratedRuleSource[];
};

export async function runAgentContext(projectDir: string, options: AgentContextOptions = {}): Promise<void> {
  const context = await buildAgentContext(projectDir, options);

  process.stdout.write(options.json ? `${JSON.stringify(context, null, 2)}\n` : formatAgentContextMarkdown(context));
}

export async function buildAgentContext(projectDir: string, options: AgentContextOptions = {}): Promise<AgentContext> {
  const config = await loadConfig(projectDir);
  const index = await buildRuleIndex(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const focus = (options.focus ?? []).map(normalizeFocusPath).filter((path) => path.length > 0);
  const relevantRules = selectRelevantRules(index.rules, focus);
  const relevantCodeShapes = selectRelevantCodeShapes(index.code_shapes, focus);
  const architectureContext = selectArchitectureContext(contract.architectures, focus);

  const generatedRuleSources = loadGeneratedRuleSources(projectDir);

  return {
    schema_version: "1",
    policy: {
      source_first: "Prefer source-code or fixture repairs before contract edits.",
      add_rule: "New rules may be added with `stele propose invariant --apply`.",
      modify_delete: "Modifying or deleting existing contract rules requires explicit user review.",
      lock: "Never refresh manifest or baseline locks unless the user approved the contract change.",
    },
    protected: index.protected,
    focus,
    relevant_rules: relevantRules,
    relevant_code_shapes: relevantCodeShapes,
    architecture_context: architectureContext,
    architectures: contract.architectures,
    coreNodes: contract.coreNodes,
    summary: index.summary,
    generated_rule_sources: generatedRuleSources.length > 0 ? generatedRuleSources : undefined,
  };
}

function formatAgentContextMarkdown(context: AgentContext): string {
  const lines = [
    "# Stele Agent Context",
    "",
    "## Maintenance policy",
    `- ${context.policy.source_first}`,
    `- ${context.policy.add_rule}`,
    `- ${context.policy.modify_delete}`,
    `- ${context.policy.lock}`,
    "",
    "## Protected contract files",
    ...context.protected.map((pattern) => `- ${pattern}`),
    "",
    "## Relevant rules",
    ...formatRuleLines(context.relevant_rules),
    "",
    "## Relevant code-shape rules",
    ...formatCodeShapeLines(context.relevant_code_shapes),
  ];

  if (context.architecture_context.length > 0) {
    lines.push("", "## Architecture constraints", ...formatArchitectureContextLines(context.architecture_context));
  }

  if (context.architectures.length > 0) {
    lines.push("", ...formatArchitectureContext(context.architectures));
  }

  if (context.coreNodes.length > 0) {
    lines.push("", ...formatCoreNodeContext(context.coreNodes));
  }

  if (context.generated_rule_sources !== undefined && context.generated_rule_sources.length > 0) {
    lines.push("", ...formatGeneratedRuleSources(context.generated_rule_sources));
  }

  return `${lines.join("\n")}\n`;
}

function formatArchitectureContextLines(entries: ArchitectureContextEntry[]): string[] {
  return entries.map((entry) =>
    `- ${entry.architecture_id} / ${entry.module_id}: allowed=${entry.allowed_dependencies.join(",")}, deny-cycles=${entry.deny_cycles}`);
}

function formatRuleLines(rules: IndexedRule[]): string[] {
  if (rules.length === 0) {
    return ["- <none>"];
  }

  return rules.map((rule) => {
    const metadata = [`severity=${rule.severity}`, `source=${rule.file_path}:${rule.line}`];
    if (rule.category !== null) {
      metadata.push(`category=${rule.category}`);
    }

    return `- ${rule.id}: ${rule.description} (${metadata.join(", ")})`;
  });
}

function formatCodeShapeLines(shapes: IndexedCodeShape[]): string[] {
  if (shapes.length === 0) {
    return ["- <none>"];
  }

  return shapes.map((shape) => `- ${shape.id}: ${shape.kind} target=${shape.target} (${shape.file_path}:${shape.line})`);
}

function formatArchitectureContext(architectures: Contract["architectures"]): string[] {
  if (architectures.length === 0) {
    return [];
  }

  const lines: string[] = ["## Architecture Constraints", ""];

  for (const arch of architectures) {
    lines.push(`### Architecture: ${arch.id}`, "");

    lines.push("**Modules:**");
    for (const mod of arch.modules) {
      lines.push(`- \`${mod.id}\`: ${mod.paths.join(" | ")}`);
    }
    lines.push("");

    lines.push("**Allowed Dependencies:**");
    for (const dep of arch.allowDependencies) {
      lines.push(`- \`${dep.from}\` → \`${dep.to.join(", ")}\``);
    }
    lines.push("");

    if (arch.denyCycles) {
      lines.push("**Cycle Policy:** Cycles are NOT allowed (deny-cycles: true)");
    } else {
      lines.push("**Cycle Policy:** Cycles are allowed");
    }
    lines.push("");
  }

  return lines;
}

function formatCoreNodeContext(coreNodes: Contract["coreNodes"]): string[] {
  if (coreNodes.length === 0) {
    return [];
  }

  const lines: string[] = ["## Core Node Boundaries", ""];

  for (const node of coreNodes) {
    lines.push(`### Core Node: ${node.id}`, "");
    lines.push(`- **Target:** \`${node.target}\``);
    lines.push(`- **Role:** ${node.role}`);

    if (node.metrics && node.metrics.length > 0) {
      lines.push("**Boundaries:**");
      for (const m of node.metrics) {
        lines.push(`- \`${m.name}\`: ideal=${m.ideal}, max=${m.max}`);
      }
    }

    lines.push("");
  }

  return lines;
}

function formatGeneratedRuleSources(sources: GeneratedRuleSource[]): string[] {
  const lines: string[] = [
    "## Generated Rule Sources",
    "",
  ];

  for (const src of sources) {
    lines.push(
      `${src.rule_id}: anchor=${src.profile_anchor}, decision=${src.decision_id}, enforcement=${src.enforcement_level}`
    );
  }

  return lines;
}

function findMatchingModule(filePath: string, architectures: Contract["architectures"]): string | null {
  for (const arch of architectures) {
    for (const mod of arch.modules) {
      for (const path of mod.paths) {
        if (filePath.includes(path.replace(/\*\*/g, ""))) {
          return `${mod.id} (arch: ${arch.id})`;
        }
      }
    }
  }
  return null;
}

function selectArchitectureContext(
  architectures: ArchitectureDeclaration[],
  focus: string[],
): ArchitectureContextEntry[] {
  if (focus.length === 0) {
    return [];
  }

  const entries: ArchitectureContextEntry[] = [];

  for (const arch of architectures) {
    for (const focusPath of focus) {
      const matchedModule = findModuleForPath(arch.modules, focusPath);
      if (matchedModule !== null) {
        const allowedDeps = getAllowedDependencies(arch, matchedModule.id);
        entries.push({
          architecture_id: arch.id,
          module_id: matchedModule.id,
          allowed_dependencies: allowedDeps,
          deny_cycles: arch.denyCycles,
        });
      }
    }
  }

  return entries;
}

function findModuleForPath(
  modules: ArchitectureModuleDeclaration[],
  filePath: string,
): ArchitectureModuleDeclaration | null {
  for (const module of modules) {
    for (const pattern of module.paths) {
      if (minimatch(filePath, pattern)) {
        return module;
      }
    }
  }
  return null;
}

function getAllowedDependencies(arch: ArchitectureDeclaration, moduleId: string): string[] {
  const dep = arch.allowDependencies.find((d) => d.from === moduleId);
  return dep ? [...dep.to] : [];
}

function selectRelevantRules(rules: IndexedRule[], focus: string[]): IndexedRule[] {
  const matching = rules.filter((rule) => focus.length > 0 && focus.some((path) => ruleMentionsFocus(rule, path)));

  if (matching.length > 0) {
    return matching;
  }

  return rules.filter((rule) => rule.severity === "critical" || rule.severity === "high").slice(0, 20);
}

function selectRelevantCodeShapes(shapes: IndexedCodeShape[], focus: string[]): IndexedCodeShape[] {
  const matching = shapes.filter((shape) => focus.length > 0 && focus.some((path) => pathOverlapsPattern(path, shape.target)));

  return matching.length > 0 ? matching : shapes.slice(0, 20);
}

function ruleMentionsFocus(rule: IndexedRule, focusPath: string): boolean {
  return [rule.file_path, rule.applies_to ?? "", rule.category ?? "", ...rule.tags]
    .filter((value) => value.length > 0)
    .some((value) => value.includes(focusPath) || focusPath.includes(value));
}

function pathOverlapsPattern(path: string, pattern: string): boolean {
  const patternPrefix = pattern.split("*")[0]?.replace(/\/+$/, "") ?? pattern;
  return patternPrefix.length === 0 || path.startsWith(patternPrefix) || pattern.includes(path);
}

function normalizeFocusPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
// ---------------------------------------------------------------------------
// Generated rule sources
// ---------------------------------------------------------------------------

function loadGeneratedRuleSources(projectDir: string): GeneratedRuleSource[] {
  const manifest = readManifest(projectDir);
  if (!manifest) return [];

  const sources: GeneratedRuleSource[] = [];

  if (manifest.outputs && manifest.outputs.length > 0) {
    for (const output of manifest.outputs) {
      for (const rule of output.rules) {
        for (const origin of rule.origins) {
          sources.push({
            rule_id: rule.id,
            profile_anchor: origin.profile_anchor,
            decision_id: origin.decision_id,
            enforcement_level: rule.enforcement_level,
          });
        }
      }
    }
  }

  if (sources.length === 0 && manifest.generatedRules.length > 0) {
    for (const entry of manifest.generatedRules) {
      const origin = entry.origin ?? "unknown";
      const enforcementLevel = entry.ruleKind === "architecture" ? "hard" : "advisory";
      const decisionId = extractDecisionIdFromOrigins(entry.origins);
      sources.push({
        rule_id: entry.ruleId,
        profile_anchor: origin,
        decision_id: decisionId,
        enforcement_level: enforcementLevel,
      });
    }
  }

  return sources;
}

function extractDecisionIdFromOrigins(origins: StructuredOrigin[] | undefined): string {
  if (!origins || origins.length === 0) return "";
  const origin = origins[0];
  switch (origin.type) {
    case "decision":
      return origin.decision_id;
    case "context":
      return origin.context_id;
    case "aggregate":
      return origin.aggregate_id;
    default:
      return "";
  }
}
