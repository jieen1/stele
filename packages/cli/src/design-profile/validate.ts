import { compilePattern } from "@stele/call-graph-core";
import type { DesignProfile, Context, SharedKernel, TraceSection } from "./types.js";

// ---------------------------------------------------------------------------
// Validation error types
// ---------------------------------------------------------------------------

export type ValidationError = {
  field: string;
  path: string;
  message: string;
};

type ValidationErrors = ValidationError[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a target string matches the `path/to/file.ts::ClassName` format.
 * Returns an error message if invalid, or undefined if valid.
 */
function validateTargetFormat(target: string, fieldPath: string): string | undefined {
  if (!target || typeof target !== "string") {
    return `target at "${fieldPath}" is required and must be a string`;
  }
  const parts = target.split("::");
  if (parts.length !== 2) {
    return `Invalid target format "${target}": expected "path/to/file.ts::ClassName"`;
  }
  const filePath = parts[0];
  const className = parts[1];
  if (!filePath || !filePath.endsWith(".ts")) {
    return `Invalid target format "${target}": file path must end with ".ts"`;
  }
  if (!className || /[\s/\\]/.test(className)) {
    return `Invalid target format "${target}": class name must be a non-empty identifier without slashes`;
  }
  return undefined;
}

/** Return true if a path contains `..` segment (path traversal). */
function isPathTraversal(p: string): boolean {
  // Normalize to forward slashes for consistent checking.
  const normalized = p.replace(/\\/g, "/");
  return normalized === ".." || normalized.startsWith("../") || normalized.includes("/../");
}

/** Collect all project-relative paths from a context or shared kernel. */
function collectPaths(context: Context): string[] {
  const paths: string[] = [];
  if (context.root) {
    paths.push(context.root);
  }
  if (context.layers && typeof context.layers === "object" && !Array.isArray(context.layers)) {
    for (const value of Object.values(context.layers)) {
      if (typeof value === "string") {
        paths.push(value);
      } else if (Array.isArray(value)) {
        paths.push(...value);
      }
    }
  }
  return paths;
}

/** Check whether two globs could overlap by checking prefix containment. */
function couldOverlap(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return na.startsWith(nb + "/") || nb.startsWith(na + "/") || na === nb;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateProfile(profile: DesignProfile, profilePath: string = "contract/design/profile.yaml"): ValidationErrors {
  const errors: ValidationErrors = [];

  // Defensive: check profile is actually an object (not null/undefined from bad YAML).
  if (!profile || typeof profile !== "object") {
    return [{ field: "profile", path: profilePath, message: "profile is null or not an object" }];
  }

  addSchemaVersionErrors(profile, errors, profilePath);
  addProjectErrors(profile, errors, profilePath);
  addDddErrors(profile, errors, profilePath);
  addTypeDrivenErrors(profile, errors, profilePath);
  addCoreInvariantErrors(profile, errors, profilePath);
  addUniquenessErrors(profile, errors, profilePath);
  if (profile.trace) {
    addTraceErrors(profile.trace, errors, profilePath);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// schema_version
// ---------------------------------------------------------------------------

function addSchemaVersionErrors(profile: DesignProfile, errors: ValidationErrors, profilePath: string): void {
  if (profile.schema_version !== 1) {
    errors.push({
      field: "schema_version",
      path: profilePath,
      message: `schema_version must be 1, got ${profile.schema_version}`,
    });
  }

  // Top-level required fields
  if (!profile.kind || typeof profile.kind !== "string") {
    errors.push({ field: "kind", path: profilePath, message: "kind is required and must be a string" });
  }
  if (!profile.profile_id || typeof profile.profile_id !== "string") {
    errors.push({ field: "profile_id", path: profilePath, message: "profile_id is required and must be a string" });
  }
  if (!profile.created_at || typeof profile.created_at !== "string") {
    errors.push({ field: "created_at", path: profilePath, message: "created_at is required and must be a string" });
  }
  if (!profile.updated_at || typeof profile.updated_at !== "string") {
    errors.push({ field: "updated_at", path: profilePath, message: "updated_at is required and must be a string" });
  }
}

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

function addProjectErrors(profile: DesignProfile, errors: ValidationErrors, profilePath: string): void {
  if (!profile.project) {
    errors.push({ field: "project", path: profilePath, message: "project section is required" });
    return;
  }

  const { language, source_roots, ignore } = profile.project;
  if (language !== "typescript") {
    errors.push({
      field: "project.language",
      path: profilePath,
      message: `project.language must be "typescript", got "${language}"`,
    });
  }

  // Check source_roots for path traversal (guard: must be array of strings)
  if (source_roots && Array.isArray(source_roots)) {
    for (const root of source_roots) {
      if (typeof root === "string" && isPathTraversal(root)) {
        errors.push({
          field: "project.source_roots",
          path: profilePath,
          message: `source_root must not contain path traversal: "${root}"`,
        });
      }
    }
  }

  // Check ignore for path traversal (guard: must be array of strings)
  if (ignore && Array.isArray(ignore)) {
    for (const pattern of ignore) {
      if (typeof pattern === "string" && isPathTraversal(pattern)) {
        errors.push({
          field: "project.ignore",
          path: profilePath,
          message: `ignore pattern must not contain path traversal: "${pattern}"`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ddd
// ---------------------------------------------------------------------------

function addDddErrors(profile: DesignProfile, errors: ValidationErrors, profilePath: string): void {
  const ddd = profile.ddd;
  if (!ddd) return;

  const contexts = ddd.contexts ?? [];
  const integrations = ddd.integrations ?? [];
  const sharedKernels = ddd.shared_kernels ?? [];
  const contextIds = new Set(contexts.map((c) => c.id));

  // --- Context schema validation ---
  for (const ctx of contexts) {
    if (!ctx.id) {
      errors.push({ field: "ddd.contexts[*].id", path: profilePath, message: "context is missing id" });
    }
    if (!ctx.name) {
      errors.push({ field: `ddd.contexts.${ctx.id ?? 'unknown'}.name`, path: profilePath, message: "context is missing name" });
    }
    if (!ctx.subdomain_type) {
      errors.push({ field: `ddd.contexts.${ctx.id ?? 'unknown'}.subdomain_type`, path: profilePath, message: "context is missing subdomain_type" });
    }
    if (!ctx.root) {
      errors.push({ field: `ddd.contexts.${ctx.id ?? 'unknown'}.root`, path: profilePath, message: "context is missing root" });
    }
    if (!ctx.layers || typeof ctx.layers !== "object" || Array.isArray(ctx.layers)) {
      errors.push({ field: `ddd.contexts.${ctx.id ?? 'unknown'}.layers`, path: profilePath, message: "context is missing layers (must be a map of layer names to glob patterns)" });
    }
  }

  // --- Path traversal in context roots and layers ---
  for (const ctx of contexts) {
    if (!ctx.root) continue; // Skip if root is missing (already reported above).
    for (const p of collectPaths(ctx)) {
      if (isPathTraversal(p)) {
        errors.push({
          field: `ddd.contexts.${ctx.id}`,
          path: profilePath,
          message: `path must not contain path traversal: "${p}"`,
        });
      }
    }
  }

  // --- Shared kernel path traversal ---
  for (const sk of sharedKernels) {
    if (!sk.paths || !Array.isArray(sk.paths)) continue;
    for (const p of sk.paths) {
      if (typeof p === "string" && isPathTraversal(p)) {
        errors.push({
          field: `ddd.shared_kernels.${sk.id}`,
          path: profilePath,
          message: `path must not contain path traversal: "${p}"`,
        });
      }
    }
  }

  // --- Integration path traversal ---
  for (const integration of integrations) {
    if (integration.adapter_module && isPathTraversal(integration.adapter_module)) {
      errors.push({
        field: `ddd.integrations.${integration.from}->${integration.to}`,
        path: profilePath,
        message: `adapter_module must not contain path traversal: "${integration.adapter_module}"`,
      });
    }
  }

  // --- Aggregate root target format validation ---
  for (const ctx of contexts) {
    for (const agg of ctx.aggregate_roots ?? []) {
      const err = validateTargetFormat(agg.target, `ddd.contexts.${ctx.id}.aggregate_roots.${agg.id}.target`);
      if (err) {
        errors.push({
          field: `ddd.contexts.${ctx.id}.aggregate_roots.${agg.id}.target`,
          path: profilePath,
          message: err,
        });
      }

      // Closeout 3a (2026-05-25): aggregate-members coherence check. When an
      // aggregate declares `aggregate_members`, every name in
      // `required_methods` / `required_fields` must appear in
      // `aggregate_members` (or be the target's own name). Mismatch is a
      // free-function-aggregate authoring error — the class-shape evaluator
      // would otherwise look for sibling names that this aggregate does not
      // claim, producing confusing "method not found" violations.
      const aggMembers = agg.aggregate_members ?? [];
      if (aggMembers.length > 0) {
        const targetName = agg.target.split("::")[1] ?? "";
        const allowed = new Set<string>([targetName, ...aggMembers]);
        for (const method of agg.required_methods ?? []) {
          if (!allowed.has(method)) {
            errors.push({
              field: `ddd.contexts.${ctx.id}.aggregate_roots.${agg.id}.required_methods`,
              path: profilePath,
              message: `required_method "${method}" is not in aggregate_members ([${aggMembers.join(", ")}]) — every required_method on a free-function aggregate must be the target name or appear in aggregate_members.`,
            });
          }
        }
        for (const field of agg.required_fields ?? []) {
          if (!allowed.has(field)) {
            errors.push({
              field: `ddd.contexts.${ctx.id}.aggregate_roots.${agg.id}.required_fields`,
              path: profilePath,
              message: `required_field "${field}" is not in aggregate_members ([${aggMembers.join(", ")}]) — every required_field on a free-function aggregate must be the target name or appear in aggregate_members.`,
            });
          }
        }
      }
    }
  }

  // --- Overlapping context roots ---
  checkOverlappingRoots(contexts, sharedKernels, errors, profilePath);

  // --- Integration references must exist ---
  for (const integration of integrations) {
    if (!contextIds.has(integration.from)) {
      errors.push({
        field: `ddd.integrations.${integration.from}->${integration.to}`,
        path: profilePath,
        message: `integration.from "${integration.from}" does not reference an existing context`,
      });
    }
    if (!contextIds.has(integration.to)) {
      errors.push({
        field: `ddd.integrations.${integration.from}->${integration.to}`,
        path: profilePath,
        message: `integration.to "${integration.to}" does not reference an existing context`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Type-driven target format validation
// ---------------------------------------------------------------------------

function addTypeDrivenErrors(profile: DesignProfile, errors: ValidationErrors, profilePath: string): void {
  const td = profile.type_driven;
  if (!td) return;

  // Branded ID type_target format (skip if not declared)
  if (td.branded_ids?.declarations) {
    for (const bid of td.branded_ids.declarations) {
      if (!bid.type_target) continue;
      const err = validateTargetFormat(
        bid.type_target,
        `type_driven.branded_ids.${bid.id ?? bid.name ?? 'unknown'}.type_target`,
      );
      if (err) {
        errors.push({
          field: `type_driven.branded_ids.${bid.id ?? bid.name ?? 'unknown'}.type_target`,
          path: profilePath,
          message: err,
        });
      }
    }
  }

  // Note: type_driven.adt is deprecated (Phase B); the field is silently accepted
  // for back-compat but never validated. Deprecation notice is emitted by loadProfile.
}

/**
 * Context roots must not overlap unless the overlap falls within a shared kernel.
 */
function checkOverlappingRoots(
  contexts: Context[],
  sharedKernels: SharedKernel[],
  errors: ValidationErrors,
  profilePath: string,
): void {
  // Collect shared kernel paths (normalized).
  const sharedPaths: string[] = [];
  for (const sk of sharedKernels) {
    for (const p of sk.paths) {
      sharedPaths.push(normalize(p));
    }
  }

  const roots: Array<{ id: string; root: string }> = contexts.map((c) => ({
    id: c.id,
    root: normalize(c.root),
  }));

  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i];
      const b = roots[j];
      if (couldOverlap(a.root, b.root)) {
        // Check if the overlap is covered by a shared kernel.
        const covered = sharedPaths.some((sp) => couldOverlap(sp, a.root) && couldOverlap(sp, b.root));
        if (!covered) {
          errors.push({
            field: "ddd.contexts",
            path: profilePath,
            message: `context roots overlap between "${a.id}" (${a.root}) and "${b.id}" (${b.root})`,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Core invariants
// ---------------------------------------------------------------------------

function addCoreInvariantErrors(profile: DesignProfile, errors: ValidationErrors, profilePath: string): void {
  const ddd = profile.ddd;
  if (!ddd || !ddd.core_invariants) return;

  for (const inv of ddd.core_invariants) {
    if (inv.status === "enforced" && !inv.enforcement) {
      errors.push({
        field: `ddd.core_invariants.${inv.id}`,
        path: profilePath,
        message: `enforced invariant "${inv.id}" must have an enforcement reference (rule_ref, scenario_ref, or external_tool_ref)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

function addUniquenessErrors(profile: DesignProfile, errors: ValidationErrors, profilePath: string): void {
  const ddd = profile.ddd;
  const td = profile.type_driven;

  // Context IDs
  checkUniqueIds(
    ddd?.contexts?.map((c) => c.id) ?? [],
    "ddd.contexts[*].id",
    errors,
    profilePath,
  );

  // Aggregate root IDs
  const allAggregateIds: string[] = [];
  for (const ctx of ddd?.contexts ?? []) {
    for (const ar of ctx.aggregate_roots ?? []) {
      allAggregateIds.push(ar.id);
    }
  }
  checkUniqueIds(allAggregateIds, "ddd.aggregate_roots[*].id", errors, profilePath);

  // Branded ID IDs (use name as fallback, skip if neither present)
  const brandedIds: string[] = [];
  if (td?.branded_ids?.declarations) {
    for (const bid of td.branded_ids.declarations) {
      const ident = bid.id ?? bid.name;
      if (ident) brandedIds.push(ident);
    }
  }
  checkUniqueIds(brandedIds, "type_driven.branded_ids[*].id", errors, profilePath);

  // Core invariant IDs
  const invariantIds = ddd?.core_invariants?.map((i) => i.id) ?? [];
  checkUniqueIds(invariantIds, "ddd.core_invariants[*].id", errors, profilePath);
}

function checkUniqueIds(ids: string[], fieldPrefix: string, errors: ValidationErrors, profilePath: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push({
        field: fieldPrefix,
        path: profilePath,
        message: `duplicate id "${id}" — ids must be unique within the collection`,
      });
    }
    seen.add(id);
  }
}

// ---------------------------------------------------------------------------
// Trace section (Phase B T3.4)
// ---------------------------------------------------------------------------

const TRACE_CONSTRAINT_FIELDS = [
  "must_transit",
  "must_be_preceded_by",
  "must_be_followed_by",
  "deny_direct",
  "deny_transit",
] as const;

function addTraceErrors(trace: TraceSection, errors: ValidationErrors, profilePath: string): void {
  if (!Array.isArray(trace.policies)) {
    errors.push({
      field: "trace.policies",
      path: profilePath,
      message: "trace.policies must be an array",
    });
    return;
  }

  const seenIds = new Set<string>();

  for (let idx = 0; idx < trace.policies.length; idx++) {
    const policy = trace.policies[idx]!;
    const ref = policy && typeof policy.id === "string" && policy.id.length > 0
      ? policy.id
      : `#${idx}`;
    const base = `trace.policies[${ref}]`;

    if (!policy || typeof policy !== "object") {
      errors.push({ field: base, path: profilePath, message: `trace policy at index ${idx} must be an object` });
      continue;
    }

    if (typeof policy.id !== "string" || policy.id.length === 0) {
      errors.push({ field: `${base}.id`, path: profilePath, message: `trace policy at index ${idx} is missing id (non-empty string)` });
    } else if (seenIds.has(policy.id)) {
      errors.push({ field: `${base}.id`, path: profilePath, message: `duplicate trace policy id "${policy.id}"` });
    } else {
      seenIds.add(policy.id);
    }

    if (policy.description !== undefined && typeof policy.description !== "string") {
      errors.push({ field: `${base}.description`, path: profilePath, message: `${base}.description must be a string when present` });
    }

    if (policy.severity !== undefined && policy.severity !== "error" && policy.severity !== "warning") {
      errors.push({
        field: `${base}.severity`,
        path: profilePath,
        message: `${base}.severity must be "error" or "warning" (got ${JSON.stringify(policy.severity)})`,
      });
    }

    if (!Array.isArray(policy.target) || policy.target.length === 0) {
      errors.push({ field: `${base}.target`, path: profilePath, message: `${base}.target must be a non-empty array of pattern strings` });
    } else {
      validatePatternArray(policy.target, `${base}.target`, errors, profilePath);
    }

    let constraintCount = 0;
    for (const field of TRACE_CONSTRAINT_FIELDS) {
      const value = policy[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        errors.push({ field: `${base}.${field}`, path: profilePath, message: `${base}.${field} must be an array of pattern strings when present` });
        continue;
      }
      if (value.length > 0) {
        constraintCount += value.length;
        validatePatternArray(value, `${base}.${field}`, errors, profilePath);
      }
    }

    if (constraintCount === 0) {
      errors.push({
        field: base,
        path: profilePath,
        message: `${base} must declare at least one of must_transit, must_be_preceded_by, must_be_followed_by, deny_direct, deny_transit`,
      });
    }

    if (policy.scope !== undefined) {
      if (!Array.isArray(policy.scope)) {
        errors.push({ field: `${base}.scope`, path: profilePath, message: `${base}.scope must be an array of pattern strings when present` });
      } else {
        validatePatternArray(policy.scope, `${base}.scope`, errors, profilePath);
      }
    }

    if (policy.exempt !== undefined) {
      if (!Array.isArray(policy.exempt)) {
        errors.push({ field: `${base}.exempt`, path: profilePath, message: `${base}.exempt must be an array when present` });
      } else {
        for (let exIdx = 0; exIdx < policy.exempt.length; exIdx++) {
          const ex = policy.exempt[exIdx]!;
          const exBase = `${base}.exempt[${exIdx}]`;
          if (!ex || typeof ex !== "object") {
            errors.push({ field: exBase, path: profilePath, message: `${exBase} must be an object with pattern and reason` });
            continue;
          }
          if (typeof ex.pattern !== "string" || ex.pattern.length === 0) {
            errors.push({ field: `${exBase}.pattern`, path: profilePath, message: `${exBase}.pattern is required (non-empty string)` });
          } else {
            validatePatternString(ex.pattern, `${exBase}.pattern`, errors, profilePath);
          }
          if (typeof ex.reason !== "string" || ex.reason.length === 0) {
            errors.push({ field: `${exBase}.reason`, path: profilePath, message: `${exBase}.reason is required (non-empty string)` });
          }
        }
      }
    }

    if (policy.fix_hint !== undefined && typeof policy.fix_hint !== "string") {
      errors.push({ field: `${base}.fix_hint`, path: profilePath, message: `${base}.fix_hint must be a string when present` });
    }
  }
}

function validatePatternArray(values: readonly string[], fieldPath: string, errors: ValidationErrors, profilePath: string): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "string") {
      errors.push({ field: `${fieldPath}[${i}]`, path: profilePath, message: `${fieldPath}[${i}] must be a string` });
      continue;
    }
    validatePatternString(v, `${fieldPath}[${i}]`, errors, profilePath);
  }
}

/**
 * Validate a NodeId pattern string. Mirrors the rejection rules in
 * `@stele/core` validator/structure-trace-policy.ts so that profile-level
 * validation produces equivalent errors to the structural parser.
 */
function validatePatternString(pattern: string, fieldPath: string, errors: ValidationErrors, profilePath: string): void {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    errors.push({ field: fieldPath, path: profilePath, message: `${fieldPath} pattern must be a non-empty string` });
    return;
  }
  if (pattern.endsWith("::")) {
    errors.push({ field: fieldPath, path: profilePath, message: `${fieldPath} pattern "${pattern}" has a trailing "::" separator` });
    return;
  }
  const arityMatch = /\(([^()]*)\)\s*(?:#[0-9a-f]{8})?\s*$/.exec(pattern);
  if (arityMatch) {
    const inside = arityMatch[1] ?? "";
    if (inside !== "" && inside !== "*" && !/^\d+$/.test(inside)) {
      errors.push({ field: fieldPath, path: profilePath, message: `${fieldPath} pattern "${pattern}" has a malformed arity "(${inside})"` });
      return;
    }
  }
  try {
    compilePattern(pattern);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ field: fieldPath, path: profilePath, message: `${fieldPath} pattern "${pattern}" failed to compile: ${msg}` });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
