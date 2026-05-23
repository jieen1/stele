// Per-context architecture rendering for the DDD design generator.

import type { Context } from "../../design-profile/types.js";
import { escapeString, layerModuleId, normalizeLayer } from "./shared.js";

/**
  * Render a single bounded context as an architecture declaration.
  * Output includes lang, tsconfig, module, layer, allow-dependency, deny-cycles, and fix fields.
  */
export function renderContextArchitecture(
  ctx: Context,
  tsconfig: string = "tsconfig.json",
): string {
  const archId = `ddd-${ctx.id}`;
  const lines: string[] = [];

  lines.push(`(architecture "${archId}"`);
  lines.push(`  (lang typescript)`);
  lines.push(`  (tsconfig "${escapeString(tsconfig)}")`);
  lines.push(
    `  (description "Generated from contract/design/profile.yaml: ${ctx.id} context must preserve DDD layer direction.")`,
  );
  lines.push("");

  // Module declarations — collect all paths per module id first
  const modulePaths = new Map<string, string[]>();
  for (const [layerName, layerPath] of Object.entries(ctx.layers)) {
    const modId = layerModuleId(ctx.id, layerName);
    const paths = normalizeLayer(layerPath);
    const existing = modulePaths.get(modId);
    if (existing) {
      existing.push(...paths);
    } else {
      modulePaths.set(modId, paths);
    }
  }
  for (const [modId, paths] of modulePaths) {
    if (paths.length === 1) {
      lines.push(`  (module ${modId}\n    (path "${escapeString(paths[0])}"))`);
    } else {
      lines.push(`  (module ${modId}`);
      for (const path of paths) {
        lines.push(`    (path "${escapeString(path)}")`);
      }
      lines.push("  )");
    }
  }

  lines.push("");

  // Layer declarations (map logical layer role to module ids)
  const layerRoleMap = buildLayerRoleMap(ctx);
  for (const [role, modIds] of layerRoleMap) {
    lines.push(`  (layer ${role} ${modIds.join(" ")})`);
  }

  lines.push("");

  // Allow-dependency rules
  const depRules = buildDependencyRules(ctx);
  for (const rule of depRules) {
    lines.push(`  (allow-dependency ${rule})`);
  }

  lines.push("");
  lines.push("  (deny-cycles)");
  lines.push(
    '  (fix "Move the dependency behind an allowed DDD layer boundary, or ask the user to approve a design-profile change."))',
  );

  return lines.join("\n");
}

function buildLayerRoleMap(ctx: Context): Array<[string, string[]]> {
  const roles: Array<[string, string[]]> = [];

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [layerName, _] of Object.entries(ctx.layers)) {
    const modId = layerModuleId(ctx.id, layerName);
    const role = mapLayerToRole(layerName);
    const existing = roles.find(([r]) => r === role);
    if (existing) {
      existing[1].push(modId);
    } else {
      roles.push([role, [modId]]);
    }
  }

  return roles;
}

function mapLayerToRole(layerName: string): string {
  const lower = layerName.toLowerCase();
  if (lower === "api" || lower === "presentation" || lower === "ui") return "presentation";
  if (lower === "application" || lower === "service" || lower === "app") return "application";
  if (lower === "domain" || lower === "core") return "domain";
  if (lower === "infrastructure" || lower === "infra") return "infrastructure";
  if (lower === "shared" || lower === "common") return "shared";
  if (lower === "public") return "public";
  return lower;
}

/**
  * Build allow-dependency rules from the context's layer ordering.
  * If layer_dependencies is defined in the profile, use those explicitly.
  * Otherwise, fall back to standard DDD: outer layers depend on inner layers.
  */
function buildDependencyRules(ctx: Context): string[] {
  const layerNames = Object.keys(ctx.layers);
  const moduleIds = layerNames.map((name) => layerModuleId(ctx.id, name));

  // Use explicit layer_dependencies from profile if provided
  if (ctx.layer_dependencies) {
    const rules: string[] = [];
    for (const [fromLayer, deps] of Object.entries(ctx.layer_dependencies)) {
      const fromMod = layerModuleId(ctx.id, fromLayer);
      const targetMods = deps.map((dep) => layerModuleId(ctx.id, dep));
      if (targetMods.length > 0) {
        rules.push(`${fromMod} ${targetMods.join(" ")}`);
      }
    }
    return rules;
  }

  // Fallback: standard DDD layer ordering
  const layerRoles = layerNames.map(mapLayerToRole);
  const layerOrder: Record<string, number> = {
    presentation: 0,
    api: 0,
    ui: 0,
    application: 1,
    service: 1,
    app: 1,
    domain: 2,
    core: 2,
    infrastructure: 3,
    infra: 3,
    shared: 4,
    common: 4,
    public: 5,
  };

  const rules: string[] = [];

  for (let i = 0; i < layerNames.length; i++) {
    const fromRole = layerRoles[i];
    const fromMod = moduleIds[i];
    const fromOrder = layerOrder[fromRole] ?? 99;

    const targets: string[] = [];
    for (let j = 0; j < layerNames.length; j++) {
      if (j === i) continue;
      const toRole = layerRoles[j];
      const toMod = moduleIds[j];
      const toOrder = layerOrder[toRole] ?? 99;

      if (toOrder > fromOrder) {
        targets.push(toMod);
      }
    }

    if (targets.length > 0) {
      rules.push(`${fromMod} ${targets.join(" ")}`);
    }
  }

  return rules;
}
