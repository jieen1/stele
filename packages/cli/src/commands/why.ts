import type { FailureWitness, Violation, ViolationLocation } from "@stele/core";
import { readLastReport, type LastCheckReport } from "../last-report.js";
import { buildRuleIndex, findIndexedRule, type IndexedRule } from "./rules.js";
import {
  formatDesignOriginLines,
  buildDesignOriginJson,
  resolveDesignOrigin,
  type DesignOriginInfo,
} from "./design-origin.js";

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
      projectDir: string;
      rule: IndexedRule;
      lastReport: LastCheckReport | undefined;
      violation: Violation | undefined;
      guidance: string[];
      designOrigin: DesignOriginInfo | null;
    }
  | {
      kind: "violation";
      projectDir: string;
      lastReport: LastCheckReport;
      violation: Violation;
      guidance: string[];
      designOrigin: DesignOriginInfo | null;
    };

async function explainWhy(projectDir: string, idOrFingerprint: string): Promise<WhyExplanation> {
  const index = await buildRuleIndex(projectDir);
  const rule = findIndexedRule(index, idOrFingerprint);
  const lastReport = await readLastReport(projectDir);
  const violation = findMatchingViolation(lastReport, idOrFingerprint, rule);

  // Resolve design-origin from the most specific identifier we have.
  const resolveId = rule !== undefined ? rule.id : violation?.rule_id ?? idOrFingerprint;
  const designOrigin = resolveDesignOrigin(projectDir, resolveId);

  if (rule !== undefined) {
    return {
      kind: "rule",
      projectDir,
      rule,
      lastReport,
      violation,
      guidance: violation === undefined ? ruleGuidance() : violationGuidance(violation.rule_kind),
      designOrigin,
    };
  }

  if (violation !== undefined && lastReport !== undefined) {
    return {
      kind: "violation",
      projectDir,
      lastReport,
      violation,
      guidance: violationGuidance(violation.rule_kind),
      designOrigin,
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
  const { rule, lastReport, violation, guidance, designOrigin } = explanation;
  const lines: string[] = [
    `Rule: ${rule.id}`,
    `Severity: ${rule.severity}`,
    `Location: ${rule.file_path}:${rule.line}`,
    `Description: ${rule.description}`,
    `Rationale: ${rule.rationale ?? "<none>"}`,
    `Generated Test: ${rule.generated_test_path}`,
    "",
  ];

  const originLines = formatDesignOriginLines(designOrigin);
  if (originLines.length > 0) {
    lines.push(...originLines);
    lines.push("");
  }

  appendLastCheckLines(lines, lastReport, violation);
  lines.push("Agent guidance:", ...guidance.map((line) => `- ${line}`));

  if (violation !== undefined) {
    lines.push("");
    lines.push(...researchTemplate(violation, designOrigin));
  }

  return `${lines.join("\n")}\n`;
}

function formatViolationOnlyHuman(explanation: Extract<WhyExplanation, { kind: "violation" }>): string {
  const { violation, guidance, designOrigin } = explanation;
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

  const originLines = formatDesignOriginLines(designOrigin);
  if (originLines.length > 0) {
    lines.push(...originLines);
  }

  lines.push("");
  appendLastCheckLines(lines, explanation.lastReport, violation);
  lines.push("Agent guidance:", ...guidance.map((line) => `- ${line}`));
  lines.push("");
  lines.push(...researchTemplate(violation, designOrigin));
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

function researchTemplate(violation: Violation, designOrigin: DesignOriginInfo | null): string[] {
  const lines: string[] = [
    "--- RESEARCH TEMPLATE ---",
    "When a contract violation blocks you, use this template to investigate:",
    "",
    "1. READ the violation source file to understand the current state",
    `2. The rule (${violation.rule_id}) enforces: "${(violation.cause.detail ?? violation.cause.summary).substring(0, 80)}..."`,
    "3. Check if the business requirement still holds",
    "4. If yes: fix the code to comply",
    "5. If no: ask human to update the contract via `stele propose`",
    "",
    "Do NOT modify protected contract files directly.",
    "Do NOT bypass violations by editing checker implementations.",
  ];

  if (designOrigin !== null) {
    lines.push(
      "",
      "Active violation research steps:",
      `  - Review design profile section: ${designOrigin.profileSection}`,
      `  - Understand why the rule was generated from: ${designOrigin.origin}`,
      `  - Rule kind: ${designOrigin.ruleKind}`,
      `  - Enforcement: ${designOrigin.enforcementLevel === "hard" ? "HARD — cannot bypass without updating design profile" : "ADVISORY — consider refactoring to meet the guideline"}`,
    );
  }

  return lines;
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

  if (ruleKind === "architecture_dependency") {
    return [
      "Module dependency violated an architecture constraint.",
      "Move the dependency behind an allowed module boundary or ask the user to approve an architecture contract change.",
      "Do not add imports that cross architecture module boundaries.",
    ];
  }

  if (ruleKind === "architecture_cycle") {
    return [
      "Dependency cycle detected between architecture modules.",
      "Break the cycle by reorganizing dependencies or adding an abstraction layer.",
      "Architecture cycles are always violations — they cannot be suppressed.",
    ];
  }

  if (ruleKind === "complexity_exceeded") {
    return [
      "Core node complexity exceeds the configured boundary.",
      "Refactor the class: extract methods, reduce SLOC, lower cyclomatic complexity.",
      "If the boundary is too aggressive, ask human to update the core-node contract.",
      "Do NOT suppress the violation by raising the max value without review.",
    ];
  }

  if (ruleKind === "typescript-config-policy") {
    return [
      "TypeScript compiler option does not match the design profile policy.",
      "Update tsconfig.json to set the required compiler option.",
      "If the policy is too strict for this project, ask human to update the design profile toolchain_contracts section.",
    ];
  }

  if (ruleKind === "typescript-diagnostic") {
    return [
      "TypeScript compiler diagnostic detected a type error.",
      "Fix the TypeScript error in the reported file and line.",
      "Do not suppress the error by adding @ts-ignore or @ts-expect-error without review.",
    ];
  }

  if (ruleKind === "eslint") {
    return [
      "ESLint rule violation detected in the reported file.",
      "Fix the lint error in the reported file and line.",
      "If the rule is a false positive, ask human to update the ESLint config or design profile toolchain_contracts section.",
    ];
  }

  if (ruleKind === "typescript-shape") {
    return [
      "Type shape violation: the target type does not match the expected shape.",
      "Update the class or interface to satisfy the required shape constraints.",
      "If the shape constraint is outdated, ask human to update the code shape contract.",
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
  const { rule, lastReport, violation, guidance, designOrigin } = explanation;
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
  if (designOrigin !== null) {
    body.design_origin = buildDesignOriginJson(designOrigin);
  }
  return body;
}

function buildViolationOnlyJson(explanation: Extract<WhyExplanation, { kind: "violation" }>): Record<string, unknown> {
  const { lastReport, violation, guidance, designOrigin } = explanation;
  const body: Record<string, unknown> = {
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
  if (designOrigin !== null) {
    body.design_origin = buildDesignOriginJson(designOrigin);
  }
  return body;
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
