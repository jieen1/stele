import { resolve } from "node:path";
import {
  createViolationReport,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import {
  checkBrandedIds,
  checkSmartConstructors,
  type BrandedIdDeclaration as TsBrandedIdDeclaration,
  type SmartConstructorTarget,
  type ShapeViolation,
  type BrandedIdViolation,
} from "@stele/type-driven-evaluator";
import { profilePathExists, loadProfile } from "../design-profile/load.js";

const RULE_KIND_BRANDED = "typescript-branded-id";
const RULE_KIND_SMART = "typescript-smart-ctor";

/**
 * Type-driven check stage: enforces (branded-id ...) and (smart-ctor ...)
 * declarations in the contract against the project's TypeScript sources.
 */
export async function buildTypeDrivenStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const brandedIds = context.contract.brandedIds;
  const smartCtors = context.contract.smartCtors;

  if (brandedIds.length === 0 && smartCtors.length === 0) {
    return createViolationReport({
      tool: "stele",
      command,
      ok: true,
      summary: {
        invariant_count: protectedState.summary.invariantCount,
        violation_count: 0,
      },
      violations: [],
    });
  }

  // Resolve tsconfig path: prefer profile.project.tsconfig, fall back to root tsconfig.json
  let tsconfigPath = resolve(context.projectDir, "tsconfig.json");
  if (profilePathExists(context.projectDir)) {
    try {
      const profile = loadProfile(context.projectDir);
      if (profile.project?.tsconfig) {
        tsconfigPath = resolve(context.projectDir, profile.project.tsconfig);
      }
    } catch {
      // ignore — fall back to default tsconfig
    }
  }

  const violations: Violation[] = [];

  // Branded IDs — check one declaration at a time so we can attribute
  // violations back to the right rule_id.
  for (const b of brandedIds) {
    const [filePath, typeName] = b.target.split("::");
    const declaration: TsBrandedIdDeclaration = {
      typeName: typeName ?? b.id,
      typeTarget: resolve(context.projectDir, filePath ?? "") + "::" + (typeName ?? b.id),
      entityScope: b.entityScope,
    };

    try {
      const brandedViolations: BrandedIdViolation[] = checkBrandedIds({
        projectDir: context.projectDir,
        tsconfigPath,
        declarations: [declaration],
      });

      for (const v of brandedViolations) {
        const ruleId = `typedriven.branded-id.${b.id}`;
        violations.push({
          rule_id: ruleId,
          rule_kind: RULE_KIND_BRANDED,
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: {
            path: relativize(context.projectDir, v.file),
            line: v.line || undefined,
            column: v.column || undefined,
          },
          cause: { summary: v.message },
          fingerprint: `${ruleId}|${v.file}|${v.line}|${v.column}`,
          scope_paths: [relativize(context.projectDir, v.file)],
          status: "active",
          fix: { summary: v.fix },
        });
      }
    } catch (e) {
      const ruleId = `typedriven.branded-id.${b.id}.execution_error`;
      violations.push({
        rule_id: ruleId,
        rule_kind: RULE_KIND_BRANDED,
        severity: "error",
        source: { tool: "stele", command, kind: "rule" },
        location: { path: "contract/generated/ddd-typedriven.stele" },
        cause: { summary: `Branded-id "${b.id}" check failed: ${e instanceof Error ? e.message : String(e)}` },
        fingerprint: ruleId,
        scope_paths: ["contract/generated/ddd-typedriven.stele"],
        status: "active",
        fix: { summary: "Ensure tsconfig and branded-id targets are valid." },
      });
    }
  }

  // Smart constructors
  if (smartCtors.length > 0) {
    const targets: SmartConstructorTarget[] = smartCtors
      .filter((s) => s.target !== undefined)
      .map((s) => ({
        id: s.id,
        classTarget: resolve(context.projectDir, (s.target ?? "").split("::")[0] ?? "") + "::" + ((s.target ?? "").split("::")[1] ?? s.id),
        factoryMethods: [s.constructorName],
      }));

    if (targets.length > 0) {
      try {
        const results = checkSmartConstructors({
          tsconfigPath,
          targets,
        });

        for (const result of results) {
          for (const v of result.violations) {
            const ruleId = `typedriven.smart-ctor.${result.target.id}`;
            violations.push({
              rule_id: ruleId,
              rule_kind: RULE_KIND_SMART,
              severity: shapeSeverity(v),
              source: { tool: "stele", command, kind: "rule" },
              location: {
                path: relativize(context.projectDir, v.file),
                line: v.line,
                column: v.column,
              },
              cause: { summary: v.message },
              fingerprint: `${ruleId}|${v.file}|${v.line ?? 0}|${v.column ?? 0}`,
              scope_paths: [relativize(context.projectDir, v.file)],
              status: "active",
              fix: { summary: v.fix },
            });
          }
        }
      } catch (e) {
        violations.push({
          rule_id: "typedriven.smart-ctor.execution_error",
          rule_kind: RULE_KIND_SMART,
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract/generated/ddd-typedriven.stele" },
          cause: { summary: `Smart-ctor check failed: ${e instanceof Error ? e.message : String(e)}` },
          fingerprint: "typedriven.smart-ctor.execution_error",
          scope_paths: ["contract/generated/ddd-typedriven.stele"],
          status: "active",
          fix: { summary: "Ensure tsconfig and smart-ctor targets are valid." },
        });
      }
    }
  }

  return createViolationReport({
    tool: "stele",
    command,
    ok: violations.length === 0,
    summary: {
      invariant_count: protectedState.summary.invariantCount,
      violation_count: violations.length,
    },
    violations,
  });
}

function shapeSeverity(v: ShapeViolation): "error" | "warning" {
  return v.severity === "warning" ? "warning" : "error";
}

function relativize(projectDir: string, file: string): string {
  const normalizedDir = projectDir.endsWith("/") ? projectDir : projectDir + "/";
  if (file.startsWith(normalizedDir)) {
    return file.slice(normalizedDir.length);
  }
  return file;
}
