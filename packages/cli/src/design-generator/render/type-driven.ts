// Type-driven declarations (Phase A: branded-id, smart-ctor).
//
// Semantics MUST NOT change here without a coordinated update to the
// type-driven check stage and a contract regeneration. Rule ids are
// `typedriven.branded-id.*` and `typedriven.smart-ctor.*` (the
// dot+hyphen form used throughout the codebase).

import type {
  BrandedId,
  DesignProfile,
  SmartConstructor,
} from "../../design-profile/types.js";
import { escapeString } from "./shared.js";

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
