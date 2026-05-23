import { loadProfile, profilePathExists } from "../../design-profile/load.js";
import { readManifest } from "../../design-generator/manifest.js";

export type DesignExplainOptions = {
  json?: boolean;
};

export interface DesignExplainResult {
  target: string;
  targetKind: "context" | "rule" | "type" | "unknown";
  profileSource: ProfileSource | null;
  ruleOrigin: RuleOriginInfo | null;
  decisionInfo: DecisionInfo | null;
}

interface ProfileSource {
  path: string;
  anchor: string;
}

interface RuleOriginInfo {
  ruleId: string;
  ruleKind: string;
  enforcementLevel: string;
  origins: Array<{ decisionId: string; profileAnchor: string }>;
}

interface DecisionInfo {
  id: string;
  questionId?: string;
  selectedOption?: string;
  rationale?: string;
}

export async function runDesignExplain(
  target: string,
  opts: DesignExplainOptions,
  projectDir: string = process.cwd(),
): Promise<void> {
  const result = await explainDesign(target, projectDir);
  const out = opts.json ? JSON.stringify(result, null, 2) : formatExplain(result);
  process.stdout.write(out + "\n");
}

async function explainDesign(target: string, projectDir: string): Promise<DesignExplainResult> {
  const result: DesignExplainResult = {
    target,
    targetKind: "unknown",
    profileSource: null,
    ruleOrigin: null,
    decisionInfo: null,
  };

  if (!profilePathExists(projectDir)) {
    return result;
  }

  const profile = await loadProfile(projectDir);

  // Parse target prefix
  if (target.startsWith("context:")) {
    result.targetKind = "context";
    const ctxId = target.slice("context:".length);
    explainContext(result, profile, ctxId);
  } else if (target.startsWith("rule:")) {
    result.targetKind = "rule";
    const ruleId = target.slice("rule:".length);
    explainRule(result, profile, ruleId, projectDir);
  } else if (target.startsWith("type:")) {
    result.targetKind = "type";
    const typeName = target.slice("type:".length);
    explainType(result, profile, typeName);
  }

  return result;
}

function explainContext(result: DesignExplainResult, profile: ReturnType<typeof loadProfile>, ctxId: string): void {
  const ctx = profile.ddd?.contexts?.find((c) => c.id === ctxId);
  if (!ctx) return;

  result.profileSource = {
    path: "contract/design/profile.yaml",
    anchor: `ddd.contexts.${ctxId}`,
  };

  const decision = findDecision(profile, ctx.decision_ref);
  result.decisionInfo = decision
    ? { id: decision.id, questionId: decision.question_id, selectedOption: decision.selected_option, rationale: decision.rationale }
    : null;
}

function explainRule(result: DesignExplainResult, _profile: ReturnType<typeof loadProfile>, ruleId: string, projectDir: string): void {
  const manifest = readManifest(projectDir);
  if (!manifest) return;

  const entry = manifest.generatedRules.find((r) => r.ruleId === ruleId);
  if (!entry) return;

  result.ruleOrigin = {
    ruleId: entry.ruleId,
    ruleKind: entry.ruleKind,
    enforcementLevel: "hard",
    origins: [{ decisionId: "unknown", profileAnchor: entry.origin }],
  };
}

function explainType(result: DesignExplainResult, profile: ReturnType<typeof loadProfile>, typeName: string): void {
  const brandedId = profile.type_driven?.branded_ids?.declarations?.find((d) => d.type_name === typeName);
  if (!brandedId) return;

  result.profileSource = {
    path: "contract/design/profile.yaml",
    anchor: `type_driven.branded_ids.${brandedId.id}`,
  };

  const decision = findDecision(profile, brandedId.decision_ref);
  result.decisionInfo = decision
    ? { id: decision.id, questionId: decision.question_id, selectedOption: decision.selected_option, rationale: decision.rationale }
    : null;
}

function findDecision(profile: ReturnType<typeof loadProfile>, decisionRef?: string): { id: string; question_id?: string; selected_option?: string; rationale?: string } | null {
  if (!decisionRef) return null;
  return profile.decisions?.find((d) => d.id === decisionRef) ?? null;
}

function formatExplain(result: DesignExplainResult): string {
  const lines: string[] = [];

  lines.push(`Design explain: ${result.target}`);

  if (result.profileSource) {
    lines.push(`  Profile source: ${result.profileSource.path}#${result.profileSource.anchor}`);
  }

  if (result.ruleOrigin) {
    lines.push(`  Rule: ${result.ruleOrigin.ruleId} (${result.ruleOrigin.ruleKind})`);
    lines.push(`  Enforcement: ${result.ruleOrigin.enforcementLevel}`);
    for (const origin of result.ruleOrigin.origins) {
      lines.push(`  Origin: ${origin.profileAnchor} (decision: ${origin.decisionId})`);
    }
  }

  if (result.decisionInfo) {
    lines.push(`  Decision: ${result.decisionInfo.id}`);
    if (result.decisionInfo.questionId) lines.push(`    Question: ${result.decisionInfo.questionId}`);
    if (result.decisionInfo.selectedOption) lines.push(`    Selected: ${result.decisionInfo.selectedOption}`);
    if (result.decisionInfo.rationale) lines.push(`    Rationale: ${result.decisionInfo.rationale}`);
  }

  if (!result.profileSource && !result.ruleOrigin && !result.decisionInfo) {
    lines.push(`  No origin found for target "${result.target}".`);
  }

  return lines.join("\n");
}
