import { buildRawCheckReport, prepareCheckContext } from "./check.js";
import { buildRuleIndex, findIndexedRule, type IndexedRule } from "./rules.js";

export type WhyOptions = {
  json?: boolean;
};

export async function runWhy(projectDir: string, idOrFingerprint: string, options: WhyOptions = {}): Promise<void> {
  const explanation = await explainWhy(projectDir, idOrFingerprint);

  process.stdout.write(options.json ? `${JSON.stringify(explanation, null, 2)}\n` : formatWhyHuman(explanation));
}

type WhyExplanation =
  | {
      kind: "rule";
      rule: IndexedRule;
      guidance: string[];
    }
  | {
      kind: "violation";
      violation: Awaited<ReturnType<typeof buildRawCheckReport>>["violations"][number];
      guidance: string[];
    };

async function explainWhy(projectDir: string, idOrFingerprint: string): Promise<WhyExplanation> {
  const index = await buildRuleIndex(projectDir);
  const rule = findIndexedRule(index, idOrFingerprint);

  if (rule !== undefined) {
    return {
      kind: "rule",
      rule,
      guidance: ruleGuidance(),
    };
  }

  const context = await prepareCheckContext(projectDir);
  const report = await buildRawCheckReport(context, "why");
  const violation = report.violations.find((candidate) => candidate.fingerprint === idOrFingerprint || candidate.rule_id === idOrFingerprint);

  if (violation === undefined) {
    throw new Error(`No Stele rule or violation matched "${idOrFingerprint}".`);
  }

  return {
    kind: "violation",
    violation,
    guidance: violationGuidance(violation.rule_kind),
  };
}

function formatWhyHuman(explanation: WhyExplanation): string {
  if (explanation.kind === "rule") {
    const { rule } = explanation;
    const lines = [
      `Rule: ${rule.id}`,
      `Severity: ${rule.severity}`,
      `Location: ${rule.file_path}:${rule.line}`,
      `Description: ${rule.description}`,
      `Rationale: ${rule.rationale ?? "<none>"}`,
      `Generated Test: ${rule.generated_test_path}`,
      "",
      "Agent guidance:",
      ...explanation.guidance.map((line) => `- ${line}`),
    ];

    return `${lines.join("\n")}\n`;
  }

  const { violation } = explanation;
  const lines = [
    `Violation: ${violation.rule_id}`,
    `Status: ${violation.status ?? "active"}`,
    `Location: ${formatLocation(violation.location)}`,
    `Cause: ${violation.cause.summary}`,
    ...(violation.fix === undefined ? [] : [`Fix: ${violation.fix.summary}`, ...(violation.fix.command === undefined ? [] : [`Command: ${violation.fix.command}`])]),
    "",
    "Agent guidance:",
    ...explanation.guidance.map((line) => `- ${line}`),
  ];

  return `${lines.join("\n")}\n`;
}

function ruleGuidance(): string[] {
  return [
    "First repair ordinary source code, fixtures, or scenario setup if they drifted.",
    "Only ask to modify this contract when the intended behavior changed.",
    "If you learned a new invariant, add it through `stele propose invariant --apply` instead of editing generated files.",
  ];
}

function violationGuidance(ruleKind: string): string[] {
  if (ruleKind === "generated_drift") {
    return [
      "Generated output drifted; inspect whether the contract intentionally changed.",
      "Run `stele generate --force` only after the contract source is approved.",
    ];
  }

  if (ruleKind === "manifest_drift" || ruleKind === "contract_hash_mismatch" || ruleKind === "protected_file_drift") {
    return [
      "Protected contract state changed.",
      "Do not refresh locks automatically; ask the user to review the contract change and reason first.",
    ];
  }

  return [
    "Repair source code, fixtures, or scenario setup before changing contract rules.",
    "Add new contract knowledge with `stele propose invariant --apply`; modifying or deleting existing rules requires user review.",
  ];
}

function formatLocation(location: { path?: string; manifest_path?: string; generated_dir?: string; line?: number; column?: number }): string {
  const base = location.path ?? location.manifest_path ?? location.generated_dir ?? "<unknown>";
  if (location.line === undefined) {
    return base;
  }

  return `${base}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
}
