// CDL renderer for DDD + Type-Driven design-profile generation.
// Produces architecture and core-node CDL strings matching existing CDL syntax.

import type { Context, Integration, AggregateRoot } from "../design-profile/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeString(s: string): string {
  // CDL uses double-quoted strings. Escape internal double quotes and backslashes.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
  * Normalize a layer value (string or string[]) into an array of glob paths.
  */
function normalizeLayer(layer: string | string[]): string[] {
  if (typeof layer === "string") return [layer];
  return layer;
}

function layerModuleId(contextId: string, layerName: string): string {
  return `${contextId}-${layerName}`;
}

function aclModuleId(fromContext: string, toContext: string): string {
  return `${fromContext}-${toContext}-acl`;
}

// ---------------------------------------------------------------------------
// Context architecture
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ACL integration
// ---------------------------------------------------------------------------

/**
  * Render an architecture declaration for cross-context ACL integration.
  * Produces ddd-context-map architecture with ACL adapter modules and cross-context dependency rules.
  */
export function renderAclIntegration(
  contexts: Context[],
  integrations: Integration[],
  tsconfig: string = "tsconfig.json",
): string {
  const lines: string[] = [];
  lines.push(`(architecture "ddd-context-map"`);
  lines.push(`  (lang typescript)`);
  lines.push(`  (tsconfig "${escapeString(tsconfig)}")`);
  lines.push(
    `  (description "Generated context map: cross-context dependencies must follow declared integration patterns.")`,
  );
  lines.push("");

  const moduleSet = new Map<string, string[]>();

  const contextMap = new Map<string, Context>();
  for (const ctx of contexts) {
    contextMap.set(ctx.id, ctx);
  }

  for (const integration of integrations) {
    const fromCtx = contextMap.get(integration.from);
    const toCtx = contextMap.get(integration.to);

    if (!fromCtx || !toCtx) continue;

    const infraPaths = fromCtx.layers.infrastructure
      ? normalizeLayer(fromCtx.layers.infrastructure)
      : [];
    const fromInfraMod = layerModuleId(integration.from, "infrastructure");

    if (infraPaths.length > 0) {
      moduleSet.set(fromInfraMod, infraPaths);
    }

    if (integration.adapter_module) {
      const aclMod = aclModuleId(integration.from, integration.to);
      moduleSet.set(aclMod, [integration.adapter_module]);
    }

    const publicPaths = toCtx.layers.public
      ? normalizeLayer(toCtx.layers.public)
      : [];
    const toPublicMod = layerModuleId(integration.to, "public");

    if (publicPaths.length > 0) {
      moduleSet.set(toPublicMod, publicPaths);
    }

    const internalPaths: string[] = [];
    if (toCtx.layers.domain) {
      internalPaths.push(...normalizeLayer(toCtx.layers.domain));
    }
    if (toCtx.layers.application) {
      internalPaths.push(...normalizeLayer(toCtx.layers.application));
    }
    if (toCtx.layers.infrastructure) {
      internalPaths.push(...normalizeLayer(toCtx.layers.infrastructure));
    }

    if (internalPaths.length > 0) {
      const toInternalMod = `${integration.to}-internal`;
      moduleSet.set(toInternalMod, internalPaths);
    }
  }

  // Render module declarations
  for (const [modId, paths] of moduleSet) {
    if (paths.length === 1) {
      lines.push(`  (module ${modId}\n    (path "${escapeString(paths[0])}"))`);
    } else {
      lines.push(`  (module ${modId}`);
      for (const p of paths) {
        lines.push(`    (path "${escapeString(p)}")`);
      }
      lines.push("  )");
    }
  }

  lines.push("");

  // Allow-dependency rules for each integration
  for (const integration of integrations) {
    const fromInfraMod = layerModuleId(integration.from, "infrastructure");
    const toPublicMod = layerModuleId(integration.to, "public");

    if (integration.pattern === "anti_corruption_layer") {
      const aclMod = aclModuleId(integration.from, integration.to);

      if (moduleSet.has(fromInfraMod) && moduleSet.has(aclMod)) {
        lines.push(`  (allow-dependency ${fromInfraMod} ${aclMod})`);
      }

      if (moduleSet.has(aclMod) && moduleSet.has(toPublicMod)) {
        lines.push(`  (allow-dependency ${aclMod} ${toPublicMod})`);
      }
    } else {
      // open_host_service or published_language
      if (moduleSet.has(fromInfraMod) && moduleSet.has(toPublicMod)) {
        lines.push(`  (allow-dependency ${fromInfraMod} ${toPublicMod})`);
      }
    }
  }

  lines.push("");
  lines.push("  (deny-cycles)");
  lines.push(
    '  (fix "Use the declared ACL module instead of importing the target context directly."))',
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core-node declarations
// ---------------------------------------------------------------------------

/**
  * Render a core-node declaration for an aggregate root.
  * Output includes lang, role, target, description, rationale, and metric fields.
  */
export function renderAggregateCoreNode(contextId: string, agg: AggregateRoot): string {
  const cnId = `${contextId}-${agg.id}-aggregate`;
  const lines: string[] = [];

  lines.push(`(core-node "${cnId}"`);
  lines.push(`  (lang typescript)`);
  lines.push(`  (role business-core-service)`);
  lines.push(`  (target "${escapeString(agg.target)}")`);
  lines.push(
    `  (description "Generated from design profile: ${agg.class} aggregate must remain reviewable.")`,
  );
  lines.push(
    `  (rationale "${agg.class} protects core ${contextId} invariants; complexity drift makes agent changes risky.")`,
  );

  // Metrics
  const m = agg.metrics;
  if (m.sloc) {
    lines.push(`  (metric sloc (ideal ${m.sloc.ideal}) (max ${m.sloc.max}))`);
  }
  if (m["public-method-count"]) {
    lines.push(`  (metric public-method-count (ideal ${m["public-method-count"].ideal}) (max ${m["public-method-count"].max}))`);
  }
  if (m["max-cyclomatic"]) {
    lines.push(`  (metric max-cyclomatic (ideal ${m["max-cyclomatic"].ideal}) (max ${m["max-cyclomatic"].max}))`);
  }

  lines.push(")");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Combined renderer
// ---------------------------------------------------------------------------

/**
  * Render all declarations from a full profile into a single CDL string.
  */
export function renderAllDeclarations(
  contextArchitectures: string[],
  aclArchitecture: string | undefined,
  coreNodes: string[],
): string {
  const parts: string[] = [...contextArchitectures];
  if (aclArchitecture) {
    parts.push(aclArchitecture);
  }
  parts.push(...coreNodes);
  return parts.join("\n\n");
}
