import { createViolationReport } from "@stele/core";
import type { Violation, ViolationReport } from "@stele/core";
import {
  evaluateArchitectureRuntime,
  type ArchitectureContractOptions,
  type ArchitectureRuntimeResult,
} from "../architecture-runtime.js";
import { pickPhaseLanguage } from "../config/phase-language.js";
import type { PreparedCheckContext, ProtectedCheckState } from "./types.js";

// ----------------------------------------------------------------
// Main
// ----------------------------------------------------------------

/**
 * Build the architecture stage report for the check pipeline.
 *
 * Delegates to evaluateArchitectureRuntime for a single pass: file discovery,
 * graph building, and evaluation. No duplicate graph building.
 */
export async function buildArchitectureStageReport(
  context: PreparedCheckContext,
  _protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const architectures = context.contract.architectures;

  if (architectures.length === 0) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        violation_count: 0,
      },
      violations: [],
    });
  }

  const allViolations: Violation[] = [];

  // Phase 0 (self-dogfooding plan): when a declaration omits its own
  // `(lang …)` field, fall back to `phaseLanguages.architecture` from
  // stele.config.json (else `targetLanguage`). Today every architecture
  // declaration sets `(lang …)` explicitly, so this is forward-compat
  // plumbing — it keeps the dispatch deterministic the moment we relax
  // that requirement.
  const phaseArchLang = pickPhaseLanguage(context.config, "architecture");
  const fallbackLang: "typescript" | "python" | undefined =
    phaseArchLang === "typescript" || phaseArchLang === "python"
      ? phaseArchLang
      : undefined;

  for (const arch of architectures) {
    const runtimeArch = convertToRuntimeArch(arch, fallbackLang);

    // Single evaluation pass: dependency, cycle, layer, public entry, unowned
    const result = await evaluateArchitectureRuntime({
      projectRoot: context.projectDir,
      architecture: runtimeArch,
    });

    allViolations.push(
      ...buildDependencyViolations(result, arch, command),
      ...buildCycleViolations(result, runtimeArch, arch, command),
      ...buildLayerDirectionViolations(result, arch, command),
      ...buildPublicEntryViolations(result, arch, command),
      ...buildUnownedFileViolations(result, arch, command),
    );
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: allViolations.length === 0,
    summary: {
      violation_count: allViolations.length,
    },
    violations: allViolations,
  });
}

// ----------------------------------------------------------------
// Violation builders
// ----------------------------------------------------------------

function buildDependencyViolations(
  result: ArchitectureRuntimeResult,
  arch: { id: string; description?: string; fix?: string },
  command: string,
): Violation[] {
  return result.dependencyViolations.map((v) => {
    const prefix = arch.description ? `${arch.description}. ` : "";
    const detail = `${prefix}Architecture violation: module "${v.fromModule}" imports from "${v.toModule}" via ${v.specifier} at ${v.fromFile}:${v.line}:${v.column}`;
    return {
      rule_id: `architecture.${arch.id}.${v.fromModule}.${v.toModule}`,
      rule_kind: "architecture_dependency" as const,
      severity: "error" as const,
      source: { tool: "stele", command, kind: "architecture" },
      location: { path: v.fromFile, line: v.line, column: v.column },
      cause: { summary: detail },
      fingerprint: `${v.fromModule}→${v.toModule}:${v.fromFile}`,
      scope_paths: [v.fromFile],
      status: "active" as const,
      fix: { summary: arch.fix ?? `Remove the import of "${v.specifier}" or move the file to an allowed module.` },
    };
  });
}

function buildCycleViolations(
  result: ArchitectureRuntimeResult,
  runtimeArch: ArchitectureContractOptions["architecture"],
  arch: { description?: string; fix?: string },
  command: string,
): Violation[] {
  return result.cycleViolations.map((cycle) => {
    const modulesStr = cycle.modules.join(" → ");
    const fileStr = cycle.edgeFiles.length > 0 ? cycle.edgeFiles.join(", ") : "multiple files";
    const prefix = arch.description ? `${arch.description}. ` : "";

    return {
      rule_id: `architecture.${runtimeArch.id}.cycle.${cycle.modules.sort().join(".")}`,
      rule_kind: "architecture_cycle" as const,
      severity: "error" as const,
      source: { tool: "stele", command, kind: "architecture" },
      location: { path: cycle.edgeFiles[0] ?? "" },
      cause: { summary: `${prefix}Architecture cycle: ${modulesStr} (files: ${fileStr})` },
      fingerprint: `architecture_cycle.${runtimeArch.id}.${cycle.modules.sort().join(".")}`,
      scope_paths: cycle.edgeFiles,
      status: "active" as const,
      fix: { summary: arch.fix ?? `Break the cycle by refactoring the dependency between modules: ${modulesStr}` },
    };
  });
}

function buildLayerDirectionViolations(
  result: ArchitectureRuntimeResult,
  arch: { id: string; description?: string; fix?: string },
  command: string,
): Violation[] {
  return result.layerDirectionViolations.map((ldv) => {
    const prefix = arch.description ? `${arch.description}. ` : "";
    return {
      rule_id: `architecture.${arch.id}.layer-direction.${ldv.fromModule}.${ldv.toModule}`,
      rule_kind: "architecture_layer_direction" as const,
      severity: "error" as const,
      source: { tool: "stele", command, kind: "architecture" },
      location: { path: ldv.fromFile, line: ldv.line ?? 0, column: ldv.column ?? 0 },
      cause: {
        summary: `${prefix}Layer direction violation: ${ldv.fromLayer} (${ldv.fromModule}) imports from ${ldv.toLayer} (${ldv.toModule}) via ${ldv.specifier} at ${ldv.fromFile}`,
      },
      fingerprint: `layer-direction.${arch.id}.${ldv.fromModule}.${ldv.toModule}:${ldv.fromFile}`,
      scope_paths: [ldv.fromFile],
      status: "active" as const,
      fix: { summary: arch.fix ?? `Move import into ${ldv.toLayer} layer or restructure layer dependency.` },
    };
  });
}

function buildPublicEntryViolations(
  result: ArchitectureRuntimeResult,
  arch: { id: string; description?: string; fix?: string },
  command: string,
): Violation[] {
  return result.publicEntryViolations.map((pev) => {
    const prefix = arch.description ? `${arch.description}. ` : "";
    return {
      rule_id: `architecture.${arch.id}.public-entry.${pev.fromModule}.${pev.toModule}`,
      rule_kind: "architecture_public_entry" as const,
      severity: "error" as const,
      source: { tool: "stele", command, kind: "architecture" },
      location: { path: pev.fromFile, line: pev.line ?? 0, column: pev.column ?? 0 },
      cause: {
        summary: `${prefix}Public entry violation: ${pev.fromModule} imports internal file ${pev.toFile} from ${pev.toModule} via ${pev.specifier}. Allowed entries: ${pev.publicEntries.join(", ")}.`,
      },
      fingerprint: `public-entry.${arch.id}.${pev.fromModule}.${pev.toModule}:${pev.fromFile}`,
      scope_paths: [pev.fromFile],
      status: "active" as const,
      fix: { summary: arch.fix ?? `Import through a public entry point of ${pev.toModule}.` },
    };
  });
}

function buildUnownedFileViolations(
  result: ArchitectureRuntimeResult,
  arch: { id: string },
  command: string,
): Violation[] {
  return result.unownedFiles.map((uf) => ({
    rule_id: `architecture.${arch.id}.unowned-file`,
    rule_kind: "architecture_unowned_file" as const,
    severity: "error" as const,
    source: { tool: "stele", command, kind: "architecture" },
    location: { path: uf },
    cause: { summary: `Unowned file: ${uf} is not matched by any module in architecture ${arch.id}` },
    fingerprint: `unowned-file.${arch.id}:${uf}`,
    scope_paths: [uf],
    status: "active" as const,
    fix: { summary: `Assign ${uf} to a module or add an ignore pattern.` },
  }));
}

// ----------------------------------------------------------------
// Conversion
// ----------------------------------------------------------------

/**
 * Convert a parsed ArchitectureDeclaration to the runtime options shape.
 */
function convertToRuntimeArch(
  arch: {
    id: string;
    lang?: "typescript" | "python";
    modules: { id: string; paths: string[] }[];
    layers?: { id: string; modules: string[] }[];
    allowDependencies: Array<{ from: string; to: string[] }>;
    denyCycles: boolean;
    tsconfig?: string;
    description?: string;
  },
  fallbackLang?: "typescript" | "python",
): ArchitectureContractOptions["architecture"] {
  return {
    id: arch.id,
    // Round 14 P2: thread the declared language through so the
    // runtime picks the matching extractor (TypeScript vs. Python).
    // Phase 0 (self-dogfooding plan): when the declaration omits
    // `(lang …)`, fall back to the per-phase config override.
    lang: arch.lang ?? fallbackLang,
    modules: arch.modules.map((m) => ({
      id: m.id,
      paths: m.paths,
    })),
    layers: arch.layers?.map((l) => ({
      id: l.id,
      modules: l.modules,
    })),
    allowDependencies: arch.allowDependencies,
    denyCycles: arch.denyCycles,
    tsconfig: arch.tsconfig,
  };
}
