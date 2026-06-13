import { resolve } from "node:path";
import {
  createViolationReport,
  ruleId,
  type Violation,
  type ViolationReport,
} from "@stele/core";
import type { PreparedCheckContext, ProtectedCheckState } from "../architecture/types.js";
import {
  checkBrandedIds,
  type BrandedIdDeclaration as TsBrandedIdDeclaration,
} from "@stele/type-driven-evaluator";
import { profilePathExists } from "../design-profile/load.js";
import { loadHashedProfile } from "../design-profile/lifecycle.js";

const RULE_KIND_BRANDED = "typescript-branded-id";

/**
 * Type-driven check stage: enforces (branded-id ...) declarations in the
 * contract against the project's TypeScript sources.
 */
export async function buildTypeDrivenStage(
  context: PreparedCheckContext,
  protectedState: ProtectedCheckState,
  command: string,
): Promise<ViolationReport> {
  const brandedIds = context.contract.brandedIds;

  if (brandedIds.length === 0) {
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
      // Closeout 4: typed DESIGN_PROFILE_LIFECYCLE chain.
      const hashed = loadHashedProfile(context.projectDir);
      if (hashed.profile.project?.tsconfig) {
        tsconfigPath = resolve(context.projectDir, hashed.profile.project.tsconfig);
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
      const { violations: brandedViolations, coverage } = checkBrandedIds({
        projectDir: context.projectDir,
        tsconfigPath,
        declarations: [declaration],
      });

      for (const v of brandedViolations) {
        const id = ruleId(`typedriven.branded-id.${b.id}`);
        violations.push({
          rule_id: id,
          rule_kind: RULE_KIND_BRANDED,
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: {
            path: relativize(context.projectDir, v.file),
            line: v.line || undefined,
            column: v.column || undefined,
          },
          cause: { summary: v.message },
          fingerprint: `${id}|${v.file}|${v.line}|${v.column}`,
          scope_paths: [relativize(context.projectDir, v.file)],
          status: "active",
          fix: { summary: v.fix },
        });
      }

      // Zero-binding guard (parity with trace/effect/type-state): a branded-id
      // that DECLARES an entity-scope but analyzes 0 files in it enforces
      // nothing at runtime — a green check that protects nothing. We fire ONLY
      // for enforced declarations (an advisory branded-id with no entity-scope
      // intentionally delegates enforcement to the Python *_USES_BRANDED_TYPE
      // invariants, so it must NOT trip the guard). Suppressed when the decl
      // already produced violations (a missing file/type is reported above).
      const cov = coverage[0];
      if (
        cov !== undefined &&
        cov.enforced &&
        cov.scopeFilesAnalyzed === 0 &&
        brandedViolations.length === 0
      ) {
        const id = ruleId(`typedriven.branded-id.${b.id}.zero_binding`);
        violations.push({
          rule_id: id,
          rule_kind: RULE_KIND_BRANDED,
          severity: "error",
          source: { tool: "stele", command, kind: "rule" },
          location: { path: "contract/generated/ddd-typedriven.stele" },
          cause: {
            summary:
              `Branded-id \`${b.id}\` declares (entity-scope "${b.entityScope}") but it resolves to 0 ` +
              `analyzable files — it enforces nothing at runtime. A green check that protects nothing is not allowed.`,
          },
          fingerprint: id,
          scope_paths: ["contract/generated/ddd-typedriven.stele"],
          status: "active",
          fix: {
            summary:
              `Fix the entity-scope glob so it matches real consumer files, or drop the (entity-scope ...) ` +
              `field to make the branded-id explicitly advisory.`,
          },
        });
      }
    } catch (e) {
      const id = ruleId(`typedriven.branded-id.${b.id}.execution_error`);
      violations.push({
        rule_id: id,
        rule_kind: RULE_KIND_BRANDED,
        severity: "error",
        source: { tool: "stele", command, kind: "rule" },
        location: { path: "contract/generated/ddd-typedriven.stele" },
        cause: { summary: `Branded-id "${b.id}" check failed: ${e instanceof Error ? e.message : String(e)}` },
        fingerprint: id,
        scope_paths: ["contract/generated/ddd-typedriven.stele"],
        status: "active",
        fix: { summary: "Ensure tsconfig and branded-id targets are valid." },
      });
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

function relativize(projectDir: string, file: string): string {
  const normalizedDir = projectDir.endsWith("/") ? projectDir : projectDir + "/";
  if (file.startsWith(normalizedDir)) {
    return file.slice(normalizedDir.length);
  }
  return file;
}
