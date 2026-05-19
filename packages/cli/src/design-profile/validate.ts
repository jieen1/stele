import type { DesignProfile, Context, Integration, SharedKernel, CoreInvariant } from "./types.js";

// ---------------------------------------------------------------------------
// Validation error types
// ---------------------------------------------------------------------------

export type ValidationError = {
  field: string;
  message: string;
};

type ValidationErrors = ValidationError[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return true if a path contains `..` segment (path traversal). */
function isPathTraversal(p: string): boolean {
  // Normalize to forward slashes for consistent checking.
  const normalized = p.replace(/\\/g, "/");
  return normalized === ".." || normalized.startsWith("../") || normalized.includes("/../");
}

/** Collect all project-relative paths from a context or shared kernel. */
function collectPaths(context: Context): string[] {
  const paths: string[] = [context.root];
  for (const value of Object.values(context.layers)) {
    if (typeof value === "string") {
      paths.push(value);
    } else if (Array.isArray(value)) {
      paths.push(...value);
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

export function validateProfile(profile: DesignProfile): ValidationErrors {
  const errors: ValidationErrors = [];

  addSchemaVersionErrors(profile, errors);
  addProjectErrors(profile, errors);
  addDddErrors(profile, errors);
  addCoreInvariantErrors(profile, errors);
  addUniquenessErrors(profile, errors);

  return errors;
}

// ---------------------------------------------------------------------------
// schema_version
// ---------------------------------------------------------------------------

function addSchemaVersionErrors(profile: DesignProfile, errors: ValidationErrors): void {
  if (profile.schema_version !== 1) {
    errors.push({
      field: "schema_version",
      message: `schema_version must be 1, got ${profile.schema_version}`,
    });
  }
}

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

function addProjectErrors(profile: DesignProfile, errors: ValidationErrors): void {
  if (!profile.project) {
    errors.push({ field: "project", message: "project section is required" });
    return;
  }

  const { language } = profile.project;
  if (language !== "typescript") {
    errors.push({
      field: "project.language",
      message: `project.language must be "typescript", got "${language}"`,
    });
  }

  // Check source_roots and ignore for path traversal
  for (const root of profile.project.source_roots ?? []) {
    if (isPathTraversal(root)) {
      errors.push({
        field: "project.source_roots",
        message: `source_root must not contain path traversal: "${root}"`,
      });
    }
  }
  for (const pattern of profile.project.ignore ?? []) {
    if (isPathTraversal(pattern)) {
      errors.push({
        field: "project.ignore",
        message: `ignore pattern must not contain path traversal: "${pattern}"`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// ddd
// ---------------------------------------------------------------------------

function addDddErrors(profile: DesignProfile, errors: ValidationErrors): void {
  const ddd = profile.ddd;
  if (!ddd) return;

  const contexts = ddd.contexts ?? [];
  const integrations = ddd.integrations ?? [];
  const sharedKernels = ddd.shared_kernels ?? [];
  const contextIds = new Set(contexts.map((c) => c.id));

  // --- Path traversal in context roots and layers ---
  for (const ctx of contexts) {
    for (const p of collectPaths(ctx)) {
      if (isPathTraversal(p)) {
        errors.push({
          field: `ddd.contexts.${ctx.id}`,
          message: `path must not contain path traversal: "${p}"`,
        });
      }
    }
  }

  // --- Shared kernel path traversal ---
  for (const sk of sharedKernels) {
    for (const p of sk.paths) {
      if (isPathTraversal(p)) {
        errors.push({
          field: `ddd.shared_kernels.${sk.id}`,
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
        message: `adapter_module must not contain path traversal: "${integration.adapter_module}"`,
      });
    }
  }

  // --- Overlapping context roots ---
  checkOverlappingRoots(contexts, sharedKernels, errors);

  // --- Integration references must exist ---
  for (const integration of integrations) {
    if (!contextIds.has(integration.from)) {
      errors.push({
        field: `ddd.integrations.${integration.from}->${integration.to}`,
        message: `integration.from "${integration.from}" does not reference an existing context`,
      });
    }
    if (!contextIds.has(integration.to)) {
      errors.push({
        field: `ddd.integrations.${integration.from}->${integration.to}`,
        message: `integration.to "${integration.to}" does not reference an existing context`,
      });
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

function addCoreInvariantErrors(profile: DesignProfile, errors: ValidationErrors): void {
  const ddd = profile.ddd;
  if (!ddd || !ddd.core_invariants) return;

  for (const inv of ddd.core_invariants) {
    if (inv.status === "enforced" && !inv.enforcement) {
      errors.push({
        field: `ddd.core_invariants.${inv.id}`,
        message: `enforced invariant "${inv.id}" must have an enforcement reference (rule_ref, scenario_ref, or external_tool_ref)`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

function addUniquenessErrors(profile: DesignProfile, errors: ValidationErrors): void {
  const ddd = profile.ddd;
  const td = profile.type_driven;

  // Context IDs
  checkUniqueIds(
    ddd?.contexts?.map((c) => c.id) ?? [],
    "ddd.contexts[*].id",
    errors,
  );

  // Aggregate root IDs
  const allAggregateIds: string[] = [];
  for (const ctx of ddd?.contexts ?? []) {
    for (const ar of ctx.aggregate_roots ?? []) {
      allAggregateIds.push(ar.id);
    }
  }
  checkUniqueIds(allAggregateIds, "ddd.aggregate_roots[*].id", errors);

  // Branded ID IDs
  const brandedIds: string[] = [];
  if (td?.branded_ids?.declarations) {
    for (const bid of td.branded_ids.declarations) {
      brandedIds.push(bid.id);
    }
  }
  checkUniqueIds(brandedIds, "type_driven.branded_ids[*].id", errors);

  // Core invariant IDs
  const invariantIds = ddd?.core_invariants?.map((i) => i.id) ?? [];
  checkUniqueIds(invariantIds, "ddd.core_invariants[*].id", errors);
}

function checkUniqueIds(ids: string[], fieldPrefix: string, errors: ValidationErrors): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push({
        field: fieldPrefix,
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
