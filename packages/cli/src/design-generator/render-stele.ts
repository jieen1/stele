// CDL renderer for DDD + Type-Driven design-profile generation.
// Produces architecture and core-node CDL strings matching existing CDL syntax.

import type {
  Context,
  Integration,
  AggregateRoot,
  BrandedId,
  SmartConstructor,
  DesignProfile,
} from "../design-profile/types.js";

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
  const paths = typeof layer === "string" ? [layer] : layer;
  return paths.map((p) => ensureGlobSuffix(p));
}

/**
 * Ensure a path ends with a glob suffix (`/**`) so that `minimatch` matches
 * files inside the directory, not just the directory itself.
 *
 * Single-file paths (e.g., "server.ts", "model.py") are left as-is — they
 * already identify exactly one file and should not be turned into directory
 * globs like "server.ts/**".
 */
function ensureGlobSuffix(path: string): string {
  if (path.endsWith("/**") || path.includes("/**/*.ts") || path.includes("/**/*.js")) {
    return path;
  }
  // Single-file path — do not append glob suffix
  if (path.match(/\.(ts|tsx|js|jsx|py|go|rs|java|kt|scala)$/)) {
    return path;
  }
  // Plain directory path like "packages/backend-typescript/src" — needs glob suffix
  if (!path.includes("**") && !path.includes("*")) {
    return `${path}/**`;
  }
  return path;
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
    // Omit infrastructure from internal — it's already registered as a separate
    // infrastructure module. Including it here causes ambiguous ownership (files
    // match both {ctx}-internal and {ctx}-infrastructure).

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

  // Allow-dependency rules: same-context module pairs are allowed in BOTH directions.
  // The context-map enforces CROSS-context purity only; within-context layer direction
  // is policed by each context's own ddd-<ctx> architecture (which uses layer_dependencies
  // for the canonical direction). Allowing both directions here prevents the context-map
  // from double-flagging legitimate within-context imports.
  for (const ctx of contexts) {
    const internalMod = `${ctx.id}-internal`;
    const infraMod = layerModuleId(ctx.id, "infrastructure");
    if (moduleSet.has(internalMod) && moduleSet.has(infraMod)) {
      lines.push(`  (allow-dependency ${internalMod} ${infraMod})`);
      lines.push(`  (allow-dependency ${infraMod} ${internalMod})`);
    }
  }

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
// Branded-id declarations
// ---------------------------------------------------------------------------

/**
 * Extract a pattern string from a profile invariant text like
 * `"matches /^[a-z]+$/"`. Returns the regex body if present, else undefined.
 */
function extractPattern(invariant: string | undefined): string | undefined {
  if (invariant === undefined) {
    return undefined;
  }
  const match = invariant.match(/\/(.+)\/[a-z]*$/);
  if (match) {
    return `/${match[1]}/`;
  }
  return undefined;
}

/**
 * Render a (branded-id ...) declaration. The shape mirrors what the
 * type-driven check stage consumes: target, base-type, optional pattern,
 * and optional entity-scope.
 */
export function renderBrandedId(decl: BrandedId): string {
  const id = decl.name ?? decl.id ?? "";
  const target = decl.type_target ?? "";
  const baseType = (decl as BrandedId & { base_type?: string }).base_type ?? "string";
  const invariantText = (decl as BrandedId & { invariant?: string }).invariant;
  const entityScope = (decl as BrandedId & { entity_scope?: string }).entity_scope;
  const pattern = extractPattern(invariantText);

  const lines: string[] = [];
  lines.push(`(branded-id "${escapeString(id)}"`);
  lines.push(`  (target "${escapeString(target)}")`);
  lines.push(`  (base-type "${escapeString(baseType)}")`);
  if (pattern !== undefined) {
    lines.push(`  (pattern "${escapeString(pattern)}")`);
  }
  if (entityScope !== undefined) {
    lines.push(`  (entity-scope "${escapeString(entityScope)}")`);
  }
  lines.push(")");
  return lines.join("\n");
}

/**
 * Render a (smart-ctor ...) declaration. Parses constructor signature like
 * `"parseRuleId(input: string): RuleId"` to extract the function name.
 */
export function renderSmartCtor(sc: SmartConstructor): string {
  const id = sc.name ?? sc.id ?? "";
  const ctorRaw = (sc as SmartConstructor & { constructor?: string }).constructor ?? "";
  const denyRaw = (sc as SmartConstructor & { deny_raw?: boolean }).deny_raw ?? false;
  const target = sc.class_target;

  // Extract just the function name from a signature like "parseRuleId(input: string): RuleId"
  const ctorName = ctorRaw.match(/^([A-Za-z_$][A-Za-z0-9_$]*)/)?.[1] ?? ctorRaw;

  const lines: string[] = [];
  lines.push(`(smart-ctor "${escapeString(id)}"`);
  lines.push(`  (constructor "${escapeString(ctorName)}")`);
  lines.push(`  (deny-raw "${denyRaw ? "true" : "false"}")`);
  if (target !== undefined) {
    lines.push(`  (target "${escapeString(target)}")`);
  }
  lines.push(")");
  return lines.join("\n");
}

/**
 * Default target derivation for self-protection profiles whose branded_ids
 * declarations do not carry an explicit type_target. Maps known branded type
 * names to the canonical file in packages/core/src/util/branded-types.ts.
 */
export function resolveBrandedIdTarget(name: string, explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  return `packages/core/src/util/branded-types.ts::${name}`;
}

/**
 * Build the list of (branded-id ...) and (smart-ctor ...) blocks from a
 * design profile. Returns rendered CDL strings.
 */
export function renderTypeDrivenDeclarations(profile: DesignProfile): {
  brandedIds: string[];
  smartCtors: string[];
} {
  const brandedIds: string[] = [];
  const smartCtors: string[] = [];

  const td = profile.type_driven;
  if (!td) {
    return { brandedIds, smartCtors };
  }

  for (const decl of td.branded_ids?.declarations ?? []) {
    const name = decl.name ?? decl.id ?? "";
    const target = resolveBrandedIdTarget(name, decl.type_target);
    brandedIds.push(renderBrandedId({ ...decl, type_target: target } as BrandedId));
  }

  for (const sc of td.smart_constructors?.value_objects ?? []) {
    smartCtors.push(renderSmartCtor(sc));
  }

  return { brandedIds, smartCtors };
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
  brandedIds: string[] = [],
  smartCtors: string[] = [],
): string {
  const parts: string[] = [...contextArchitectures];
  if (aclArchitecture) {
    parts.push(aclArchitecture);
  }
  parts.push(...coreNodes);
  parts.push(...brandedIds);
  parts.push(...smartCtors);
  return parts.join("\n\n");
}
