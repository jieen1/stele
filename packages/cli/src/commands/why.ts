import type { FailureWitness, Violation, ViolationLocation } from "@stele/core";
import { readLastReport, type LastCheckReport } from "../last-report.js";
import { buildRuleIndex, findIndexedRule, type IndexedRule } from "./rules.js";

export type WhyOptions = {
  json?: boolean;
};

export async function runWhy(projectDir: string, idOrFingerprint: string, options: WhyOptions = {}): Promise<void> {
  const explanation = await explainWhy(projectDir, idOrFingerprint);

  process.stdout.write(options.json ? `${JSON.stringify(buildWhyJson(explanation), null, 2)}\n` : formatWhyHuman(explanation));
}

type WhyExplanation =
  | {
      kind: "rule";
      rule: IndexedRule;
      lastReport: LastCheckReport | undefined;
      violation: Violation | undefined;
      guidance: string[];
    }
  | {
      kind: "violation";
      lastReport: LastCheckReport;
      violation: Violation;
      guidance: string[];
    };

async function explainWhy(projectDir: string, idOrFingerprint: string): Promise<WhyExplanation> {
  const index = await buildRuleIndex(projectDir);
  const rule = findIndexedRule(index, idOrFingerprint);
  const lastReport = await readLastReport(projectDir);
  const violation = findMatchingViolation(lastReport, idOrFingerprint, rule);

  if (rule !== undefined) {
    return {
      kind: "rule",
      rule,
      lastReport,
      violation,
      guidance: violation === undefined ? ruleGuidance() : violationGuidance(violation.rule_kind),
    };
  }

  if (violation !== undefined && lastReport !== undefined) {
    return {
      kind: "violation",
      lastReport,
      violation,
      guidance: violationGuidance(violation.rule_kind),
    };
  }

  throw new Error(`No Stele rule or violation matched "${idOrFingerprint}".`);
}

function findMatchingViolation(
  lastReport: LastCheckReport | undefined,
  idOrFingerprint: string,
  rule: IndexedRule | undefined,
): Violation | undefined {
  if (lastReport === undefined) {
    return undefined;
  }

  return lastReport.report.violations.find((violation) => {
    if (violation.fingerprint === idOrFingerprint) {
      return true;
    }
    if (violation.rule_id === idOrFingerprint) {
      return true;
    }
    if (rule !== undefined && violation.rule_id === rule.id) {
      return true;
    }
    return false;
  });
}

function formatWhyHuman(explanation: WhyExplanation): string {
  if (explanation.kind === "rule") {
    return formatRuleHuman(explanation);
  }
  return formatViolationOnlyHuman(explanation);
}

function formatRuleHuman(explanation: Extract<WhyExplanation, { kind: "rule" }>): string {
  const { rule, lastReport, violation, guidance } = explanation;
  const lines: string[] = [
    `Rule: ${rule.id}`,
    `Severity: ${rule.severity}`,
    `Location: ${rule.file_path}:${rule.line}`,
    `Description: ${rule.description}`,
    `Rationale: ${rule.rationale ?? "<none>"}`,
    `Generated Test: ${rule.generated_test_path}`,
    "",
  ];

  appendLastCheckLines(lines, lastReport, violation);
  lines.push("Agent guidance:", ...guidance.map((line) => `- ${line}`));

  return `${lines.join("\n")}\n`;
}

function formatViolationOnlyHuman(explanation: Extract<WhyExplanation, { kind: "violation" }>): string {
  const { lastReport, violation, guidance } = explanation;
  const lines: string[] = [
    `Violation: ${violation.rule_id}`,
    `Status: ${violation.status ?? "active"}`,
    `Location: ${formatLocation(violation.location)}`,
  ];
  if (violation.fix !== undefined) {
    lines.push(`Fix: ${violation.fix.summary}`);
    if (violation.fix.command !== undefined) {
      lines.push(`Command: ${violation.fix.command}`);
    }
  }
  lines.push("");
  appendLastCheckLines(lines, lastReport, violation);
  lines.push("Agent guidance:", ...guidance.map((line) => `- ${line}`));
  return `${lines.join("\n")}\n`;
}

function appendLastCheckLines(
  lines: string[],
  lastReport: LastCheckReport | undefined,
  violation: Violation | undefined,
): void {
  if (lastReport === undefined) {
    lines.push("Last check: no recent report (run `stele check` to generate one).", "");
    return;
  }

  if (violation === undefined) {
    lines.push(`Last check: ${lastReport.generated_at} (passing)`, "");
    return;
  }

  const status = violation.status === "suppressed" ? "suppressed" : "failed";
  lines.push(`Last check: ${lastReport.generated_at} (${status})`, "");
  lines.push(`Cause: ${violation.cause.summary}`);
  if (violation.cause.detail !== undefined) {
    lines.push(`Detail: ${violation.cause.detail}`);
  }
  if (violation.cause.failure_witness !== undefined) {
    lines.push(...formatWitnessLines(violation.cause.failure_witness));
  }
  lines.push("");
}

function formatWitnessLines(witness: FailureWitness): string[] {
  const lines: string[] = [
    "Failure witness:",
    `  operator: ${witness.operator}`,
    `  collection_size: ${witness.collection_size}`,
  ];
  if (witness.failed_at_index !== undefined) {
    lines.push(`  failed at index: ${witness.failed_at_index}`);
  }
  if (witness.failed_item !== undefined) {
    lines.push(`  failed item: ${formatFailedItem(witness.failed_item)}`);
  }
  if (witness.predicate_source !== undefined) {
    lines.push(`  predicate: ${witness.predicate_source}`);
  }
  if (witness.truncated) {
    lines.push("  (truncated to fit witness byte cap)");
  }
  return lines;
}

function formatFailedItem(item: unknown): string {
  const json = JSON.stringify(item, null, 2);
  if (json === undefined) {
    return String(item);
  }

  return json
    .split("\n")
    .map((line, index) => (index === 0 ? line : `    ${line}`))
    .join("\n");
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

function formatLocation(location: ViolationLocation): string {
  const base = location.path ?? location.manifest_path ?? location.generated_dir ?? "<unknown>";
  if (location.line === undefined) {
    return base;
  }

  return `${base}:${location.line}${location.column === undefined ? "" : `:${location.column}`}`;
}

function buildWhyJson(explanation: WhyExplanation): Record<string, unknown> {
  if (explanation.kind === "rule") {
    return buildRuleJson(explanation);
  }
  return buildViolationOnlyJson(explanation);
}

function buildRuleJson(explanation: Extract<WhyExplanation, { kind: "rule" }>): Record<string, unknown> {
  const { rule, lastReport, violation, guidance } = explanation;
  const body: Record<string, unknown> = {
    schema_version: "1",
    tool: "@stele/cli",
    command: "why",
    rule_id: rule.id,
    severity: rule.severity,
    description: rule.description,
  };

  if (rule.rationale !== null) {
    body.rationale = rule.rationale;
  }
  if (rule.category !== null) {
    body.category = rule.category;
  }
  body.location = {
    file_path: rule.file_path,
    line: rule.line,
    column: rule.column,
  };
  body.generated_test_path = rule.generated_test_path;

  body.last_check_at = lastReport?.generated_at;
  body.last_check_status = describeLastCheckStatus(lastReport, violation);
  if (violation !== undefined) {
    body.violation = serializeViolationForJson(violation);
  }
  body.guidance = guidance;
  return body;
}

function buildViolationOnlyJson(explanation: Extract<WhyExplanation, { kind: "violation" }>): Record<string, unknown> {
  const { lastReport, violation, guidance } = explanation;
  return {
    schema_version: "1",
    tool: "@stele/cli",
    command: "why",
    rule_id: violation.rule_id,
    severity: violation.severity,
    description: violation.cause.summary,
    last_check_at: lastReport.generated_at,
    last_check_status: violation.status === "suppressed" ? "suppressed" : "failed",
    violation: serializeViolationForJson(violation),
    guidance,
  };
}

function describeLastCheckStatus(
  lastReport: LastCheckReport | undefined,
  violation: Violation | undefined,
): "failed" | "suppressed" | "passing" | "no-report" {
  if (lastReport === undefined) {
    return "no-report";
  }
  if (violation === undefined) {
    return "passing";
  }
  return violation.status === "suppressed" ? "suppressed" : "failed";
}

function serializeViolationForJson(violation: Violation): Record<string, unknown> {
  return {
    rule_id: violation.rule_id,
    rule_kind: violation.rule_kind,
    severity: violation.severity,
    fingerprint: violation.fingerprint,
    scope_paths: violation.scope_paths,
    status: violation.status ?? "active",
    location: violation.location,
    cause: violation.cause,
    fix: violation.fix,
  };
}
