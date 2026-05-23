import type { DesignProfile, Context, SharedKernel } from "./types.js";

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

  // ADT entity type_target format (skip if not declared)
  if (td.adt?.entities) {
    for (const entity of td.adt.entities) {
      if (!entity.type_target) continue;
      const err = validateTargetFormat(
        entity.type_target,
        `type_driven.adt.entities.${entity.name}.type_target`,
      );
      if (err) {
        errors.push({
          field: `type_driven.adt.entities.${entity.name}.type_target`,
          path: profilePath,
          message: err,
        });
      }
    }
  }

  // Smart constructor class_target format (skip if not declared)
  if (td.smart_constructors?.value_objects) {
    for (const sc of td.smart_constructors.value_objects) {
      if (!sc.class_target) continue;
      const err = validateTargetFormat(
        sc.class_target,
        `type_driven.smart_constructors.${sc.id ?? sc.name ?? 'unknown'}.class_target`,
      );
      if (err) {
        errors.push({
          field: `type_driven.smart_constructors.${sc.id ?? sc.name ?? 'unknown'}.class_target`,
          path: profilePath,
          message: err,
        });
      }
    }
  }
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
// Helpers
// ---------------------------------------------------------------------------

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
