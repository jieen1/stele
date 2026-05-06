import { buildRuleIndex, type IndexedCodeShape, type IndexedRule, type RuleIndex } from "./rules.js";

export type AgentContextOptions = {
  json?: boolean;
  focus?: string[];
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
  summary: RuleIndex["summary"];
};

export async function runAgentContext(projectDir: string, options: AgentContextOptions = {}): Promise<void> {
  const context = await buildAgentContext(projectDir, options);

  process.stdout.write(options.json ? `${JSON.stringify(context, null, 2)}\n` : formatAgentContextMarkdown(context));
}

export async function buildAgentContext(projectDir: string, options: AgentContextOptions = {}): Promise<AgentContext> {
  const index = await buildRuleIndex(projectDir);
  const focus = (options.focus ?? []).map(normalizeFocusPath).filter((path) => path.length > 0);
  const relevantRules = selectRelevantRules(index.rules, focus);
  const relevantCodeShapes = selectRelevantCodeShapes(index.code_shapes, focus);

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
    summary: index.summary,
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

  return `${lines.join("\n")}\n`;
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
