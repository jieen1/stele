import { resolve } from "node:path";
import { loadContract, type InvariantDeclaration } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { formatAstNode } from "../utils/ast-format.js";
import { translateContract, isTranslationCandidate, type IrTerm } from "../lint/translate.js";
import type { Finding } from "../lint/analyze.js";

export type LintOptions = { json?: boolean; strict?: boolean };

export type SkippedInvariant = { id: string; reason: string };

export type LintReport = {
  version: 1;
  coverage: {
    totalInvariants: number;
    translated: number;
    skipped: SkippedInvariant[];
  };
  findings: Finding[];
  summary: {
    contradictions: number;
    tautologies: number;
    redundancies: number;
    equivalences: number;
    incomplete: number;
  };
};

export type LintResult = { exitCode: 0 | 1; report: LintReport; text: string };

const DEFAULT_TIMEOUT_MS = 10000;

export async function runLint(projectDir: string, options: LintOptions): Promise<LintResult> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const invariants = contract.invariants;

  // Command-layer skips: every non-candidate (uses-checker / no-assert).
  const skipped: SkippedInvariant[] = [];
  for (const inv of invariants) {
    if (isTranslationCandidate(inv)) continue;
    skipped.push({ id: inv.id, reason: inv.usesChecker !== undefined ? "uses-checker" : "no-assert" });
  }

  // Translator: candidates only.
  const translation = translateContract(invariants);
  const translatable: Array<{ id: string; term: IrTerm }> = [];
  for (const t of translation.translated) {
    if (t.ok) translatable.push({ id: t.id, term: t.term });
    else skipped.push({ id: t.id, reason: t.reason });
  }

  let findings: Finding[] = [];
  if (translatable.length > 0) {
    // Lazy z3 import lives entirely inside analyze.ts.
    const { analyze } = await import("../lint/analyze.js");
    const result = await analyze(
      { pathSorts: translation.pathSorts, translatable },
      { perCheckTimeoutMs: DEFAULT_TIMEOUT_MS },
    );
    findings = result.findings;
  }

  findings = sortFindings(findings);
  skipped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const report: LintReport = {
    version: 1,
    coverage: {
      totalInvariants: invariants.length,
      translated: translatable.length,
      skipped,
    },
    findings,
    summary: summarize(findings),
  };

  const hasContradiction = findings.some((f) => f.kind === "contradiction");
  const hasWarning = findings.some(
    (f) => f.kind === "tautology" || f.kind === "subsumption" || f.kind === "equivalent",
  );
  const exitCode: 0 | 1 = hasContradiction ? 1 : options.strict === true && hasWarning ? 1 : 0;

  const text = options.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report, invariants);

  return { exitCode, report, text };
}

function summarize(findings: Finding[]): LintReport["summary"] {
  let contradictions = 0;
  let tautologies = 0;
  let redundancies = 0;
  let equivalences = 0;
  let incomplete = 0;
  for (const f of findings) {
    switch (f.kind) {
      case "contradiction":
        contradictions += 1;
        break;
      case "tautology":
        tautologies += 1;
        break;
      case "subsumption":
        redundancies += 1;
        break;
      case "equivalent":
        equivalences += 1;
        break;
      case "incomplete":
        incomplete += 1;
        break;
    }
  }
  return { contradictions, tautologies, redundancies, equivalences, incomplete };
}

const KIND_RANK: Record<Finding["kind"], number> = {
  contradiction: 0,
  tautology: 1,
  subsumption: 2,
  equivalent: 3,
  incomplete: 4,
};

function primaryId(f: Finding): string {
  switch (f.kind) {
    case "contradiction":
      return f.invariants[0] ?? "";
    case "tautology":
      return f.invariant;
    case "subsumption":
      return f.subsumes;
    case "equivalent":
      return f.invariants[0] ?? "";
    case "incomplete":
      return f.subject[0] ?? "";
  }
}

function secondaryId(f: Finding): string {
  switch (f.kind) {
    case "contradiction":
      return f.invariants[1] ?? "";
    case "tautology":
      return "";
    case "subsumption":
      return f.redundant;
    case "equivalent":
      return f.invariants[1] ?? "";
    case "incomplete":
      return f.subject[1] ?? "";
  }
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) => {
    const ka = KIND_RANK[a.kind];
    const kb = KIND_RANK[b.kind];
    if (ka !== kb) return ka - kb;
    const pa = primaryId(a);
    const pb = primaryId(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const sa = secondaryId(a);
    const sb = secondaryId(b);
    if (sa !== sb) return sa < sb ? -1 : 1;
    return 0;
  });
}

function renderHuman(report: LintReport, invariants: InvariantDeclaration[]): string {
  const assertById = new Map<string, string>();
  for (const inv of invariants) {
    if (inv.assertExpression !== undefined) assertById.set(inv.id, formatAstNode(inv.assertExpression));
  }
  const assertText = (id: string): string => assertById.get(id) ?? "<uses-checker>";

  const lines: string[] = [];
  const t = report.coverage.translated;
  const s = report.coverage.skipped.length;
  lines.push(`stele lint: ${t} invariant(s) analyzed, ${s} skipped`);

  const { findings } = report;
  const hasIssue = findings.length > 0;
  if (!hasIssue && s === 0) {
    lines.push("no issues found");
    return `${lines.join("\n")}\n`;
  }

  const contradictions = findings.filter((f): f is Extract<Finding, { kind: "contradiction" }> => f.kind === "contradiction");
  for (const f of contradictions) {
    lines.push("");
    lines.push("CONTRADICTION  the contract can never be satisfied");
    lines.push(`  conflicting set: ${f.invariants.join(", ")}`);
    for (const id of f.invariants) lines.push(`    ${id}  ${assertText(id)}`);
  }

  const tautologies = findings.filter((f): f is Extract<Finding, { kind: "tautology" }> => f.kind === "tautology");
  for (const f of tautologies) {
    lines.push("");
    lines.push(`TAUTOLOGY  ${f.invariant} is always true and constrains nothing`);
    lines.push(`    ${f.invariant}  ${assertText(f.invariant)}`);
  }

  const subsumptions = findings.filter((f): f is Extract<Finding, { kind: "subsumption" }> => f.kind === "subsumption");
  for (const f of subsumptions) {
    lines.push("");
    lines.push(`REDUNDANCY  ${f.redundant} is implied by ${f.subsumes} (redundant)`);
    lines.push(`    ${f.subsumes}  ${assertText(f.subsumes)}`);
    lines.push(`    ${f.redundant}  ${assertText(f.redundant)}`);
  }

  const equivalents = findings.filter((f): f is Extract<Finding, { kind: "equivalent" }> => f.kind === "equivalent");
  for (const f of equivalents) {
    lines.push("");
    lines.push(`EQUIVALENT  ${f.invariants[0]} and ${f.invariants[1]} are logically equivalent`);
    for (const id of f.invariants) lines.push(`    ${id}  ${assertText(id)}`);
  }

  const incompletes = findings.filter((f): f is Extract<Finding, { kind: "incomplete" }> => f.kind === "incomplete");
  for (const f of incompletes) {
    lines.push("");
    const subj = f.subject.length === 0 ? "whole contract" : `(${f.subject.join(", ")})`;
    lines.push(`INCOMPLETE  analysis undetermined (timeout) for: ${f.analysis} ${subj}`);
  }

  if (s > 0) {
    lines.push("");
    lines.push("skipped (not statically analyzable):");
    const width = Math.max(...report.coverage.skipped.map((entry) => entry.id.length));
    for (const entry of report.coverage.skipped) {
      lines.push(`  ${entry.id.padEnd(width)}  ${entry.reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
