// Cross-context ACL integration architecture rendering.

import type { Context, Integration } from "../../design-profile/types.js";
import { aclModuleId, escapeString, layerModuleId, normalizeLayer } from "./shared.js";

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

  // Allow-dependency rules for each integration. When the canonical
  // <from>-infrastructure / <to>-public modules are absent (transaction-script
  // contexts that only declare a `domain` layer), fall back to <from>-internal
  // / <to>-internal so the declared integration still allow-lists the cross-
  // context edge instead of leaving it deny-by-default.
  for (const integration of integrations) {
    const fromInfraMod = layerModuleId(integration.from, "infrastructure");
    const toPublicMod = layerModuleId(integration.to, "public");
    const fromInternalMod = `${integration.from}-internal`;
    const toInternalMod = `${integration.to}-internal`;
    const fromMod = moduleSet.has(fromInfraMod) ? fromInfraMod : fromInternalMod;
    const toMod = moduleSet.has(toPublicMod) ? toPublicMod : toInternalMod;

    if (integration.pattern === "anti_corruption_layer") {
      const aclMod = aclModuleId(integration.from, integration.to);

      if (moduleSet.has(fromMod) && moduleSet.has(aclMod)) {
        lines.push(`  (allow-dependency ${fromMod} ${aclMod})`);
      }

      if (moduleSet.has(aclMod) && moduleSet.has(toMod)) {
        lines.push(`  (allow-dependency ${aclMod} ${toMod})`);
      }
    } else {
      // open_host_service or published_language
      if (moduleSet.has(fromMod) && moduleSet.has(toMod)) {
        lines.push(`  (allow-dependency ${fromMod} ${toMod})`);
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
