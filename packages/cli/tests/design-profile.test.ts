import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as yaml from "js-yaml";
import type { DesignProfile } from "../src/design-profile/types.js";
import { loadProfile, profilePathExists } from "../src/design-profile/load.js";
import { validateProfile } from "../src/design-profile/validate.js";
import { hashFile, hashString } from "../src/design-profile/hash.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stele-design-profile-"));
  tempDirs.push(dir);
  return dir;
}

function minimalProfile(): DesignProfile {
  return {
    schema_version: 1,
    kind: "stele-design-profile",
    profile_id: "test",
    created_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-19T00:00:00.000Z",
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: ["src/generated/**/*"],
    },
  };
}

async function writeProfile(dir: string, profile: DesignProfile): Promise<string> {
  const contractDir = join(dir, "contract", "design");
  const filePath = join(contractDir, "profile.yaml");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, yaml.dump(profile), "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Minimal profile
// ---------------------------------------------------------------------------

describe("minimal profile", () => {
  it("parses a valid minimal profile correctly", async () => {
    const dir = await createTempDir();
    await writeProfile(dir, minimalProfile());

    const profile = loadProfile(dir);
    expect(profile.schema_version).toBe(1);
    expect(profile.kind).toBe("stele-design-profile");
    expect(profile.profile_id).toBe("test");
    expect(profile.project?.language).toBe("typescript");
    expect(profile.project?.source_roots).toEqual(["src"]);
    expect(profile.project?.ignore).toEqual(["src/generated/**/*"]);
  });

  it("profilePathExists returns true when file exists", async () => {
    const dir = await createTempDir();
    await writeProfile(dir, minimalProfile());

    expect(profilePathExists(dir)).toBe(true);
  });

  it("profilePathExists returns false when file does not exist", () => {
    const dir = join(tmpdir(), "stele-nonexistent-" + Date.now());
    expect(profilePathExists(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation: schema_version
// ---------------------------------------------------------------------------

describe("validateProfile — schema_version", () => {
  it("passes when schema_version is 1", () => {
    const profile = minimalProfile();
    const errors = validateProfile(profile);
    expect(errors).toEqual([]);
  });

  it("fails when schema_version is not 1", () => {
    const profile = { ...minimalProfile(), schema_version: 2 } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "schema_version");
    expect(err).toBeDefined();
    expect(err!.message).toContain("schema_version must be 1");
  });
});

// ---------------------------------------------------------------------------
// Validation: project.language
// ---------------------------------------------------------------------------

describe("validateProfile — project.language", () => {
  it("fails when language is not typescript", () => {
    const profile = {
      ...minimalProfile(),
      project: { ...minimalProfile().project!, language: "python" },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "project.language");
    expect(err).toBeDefined();
    expect(err!.message).toContain("typescript");
  });

  it("passes when language is typescript", () => {
    const profile = minimalProfile();
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "project.language");
    expect(err).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation: path traversal
// ---------------------------------------------------------------------------

describe("validateProfile — path traversal", () => {
  it("detects path traversal in source_roots", () => {
    const profile = {
      ...minimalProfile(),
      project: {
        ...minimalProfile().project!,
        source_roots: ["../outside"],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "project.source_roots");
    expect(err).toBeDefined();
    expect(err!.message).toContain("path traversal");
  });

  it("detects path traversal in ignore patterns", () => {
    const profile = {
      ...minimalProfile(),
      project: {
        ...minimalProfile().project!,
        ignore: ["../../escape/**/*"],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "project.ignore");
    expect(err).toBeDefined();
    expect(err!.message).toContain("path traversal");
  });

  it("detects path traversal in context root", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "ctx",
            name: "Ctx",
            subdomain_type: "core",
            root: "../evil",
            layers: {},
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.contexts.ctx");
    expect(err).toBeDefined();
    expect(err!.message).toContain("path traversal");
  });

  it("detects path traversal in context layers", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "ctx",
            name: "Ctx",
            subdomain_type: "core",
            root: "src/ctx",
            layers: {
              domain: "../escape/domain/**/*.ts",
            },
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.contexts.ctx");
    expect(err).toBeDefined();
    expect(err!.message).toContain("path traversal");
  });
});

// ---------------------------------------------------------------------------
// Validation: overlapping context roots
// ---------------------------------------------------------------------------

describe("validateProfile — overlapping context roots", () => {
  it("detects overlapping context roots", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
          {
            id: "payments",
            name: "Payments",
            subdomain_type: "supporting",
            root: "src/billing/payments",
            layers: {},
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.contexts");
    expect(err).toBeDefined();
    expect(err!.message).toContain("overlap");
  });

  it("allows non-overlapping context roots", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
          {
            id: "customer",
            name: "Customer",
            subdomain_type: "supporting",
            root: "src/customer",
            layers: {},
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.contexts" && e.message.includes("overlap"));
    expect(err).toBeUndefined();
  });

  it("allows overlap when shared kernel declares the path", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/shared/billing",
            layers: {},
          },
          {
            id: "customer",
            name: "Customer",
            subdomain_type: "supporting",
            root: "src/shared/customer",
            layers: {},
          },
        ],
        shared_kernels: [
          {
            id: "shared-domain",
            paths: ["src/shared/**/*.ts"],
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.contexts" && e.message.includes("overlap"));
    expect(err).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation: integration references
// ---------------------------------------------------------------------------

describe("validateProfile — integration references", () => {
  it("fails when integration.from references a missing context", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "customer",
            name: "Customer",
            subdomain_type: "supporting",
            root: "src/customer",
            layers: {},
          },
        ],
        integrations: [
          {
            from: "billing",
            to: "customer",
            pattern: "anti_corruption_layer",
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.message.includes("integration.from"));
    expect(err).toBeDefined();
    expect(err!.message).toContain("billing");
  });

  it("fails when integration.to references a missing context", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
        ],
        integrations: [
          {
            from: "billing",
            to: "nonexistent",
            pattern: "open_host_service",
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.message.includes("integration.to"));
    expect(err).toBeDefined();
    expect(err!.message).toContain("nonexistent");
  });

  it("passes when all integration references exist", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
          {
            id: "customer",
            name: "Customer",
            subdomain_type: "supporting",
            root: "src/customer",
            layers: {},
          },
        ],
        integrations: [
          {
            from: "billing",
            to: "customer",
            pattern: "anti_corruption_layer",
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find(
      (e) => e.message.includes("integration") && e.message.includes("context"),
    );
    expect(err).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation: enforced invariant references
// ---------------------------------------------------------------------------

describe("validateProfile — enforced invariants", () => {
  it("fails when enforced invariant has no resolvable reference", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
        ],
        core_invariants: [
          {
            id: "inv1",
            description: "Must have a reference",
            evolvability: "never",
            status: "enforced",
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.message.includes("enforced"));
    expect(err).toBeDefined();
    expect(err!.message).toContain("enforcement reference");
  });

  it("passes when enforced invariant has rule_ref", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
        ],
        core_invariants: [
          {
            id: "inv1",
            description: "Has rule ref",
            evolvability: "never",
            status: "enforced",
            enforcement: {
              kind: "stele-rule",
              rule_ref: "INVOICE_TOTAL_NON_NEGATIVE",
            },
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.message.includes("enforced") && e.message.includes("enforcement reference"));
    expect(err).toBeUndefined();
  });

  it("passes when enforced invariant has scenario_ref", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
        ],
        core_invariants: [
          {
            id: "inv1",
            description: "Has scenario ref",
            evolvability: "with-review",
            status: "enforced",
            enforcement: {
              kind: "scenario-required",
              scenario_ref: "scenario-inv1",
            },
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.message.includes("enforced") && e.message.includes("enforcement reference"));
    expect(err).toBeUndefined();
  });

  it("passes when invariant is pending (no enforcement required)", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
          },
        ],
        core_invariants: [
          {
            id: "inv1",
            description: "Pending invariant",
            evolvability: "never",
            status: "pending",
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.message.includes("enforced") && e.message.includes("enforcement reference"));
    expect(err).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation: uniqueness
// ---------------------------------------------------------------------------

describe("validateProfile — uniqueness", () => {
  it("fails when context IDs are duplicated", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          { id: "ctx", name: "A", subdomain_type: "core", root: "src/a", layers: {} },
          { id: "ctx", name: "B", subdomain_type: "supporting", root: "src/b", layers: {} },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.contexts[*].id");
    expect(err).toBeDefined();
    expect(err!.message).toContain("unique");
  });

  it("fails when aggregate IDs are duplicated", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            layers: {},
            aggregate_roots: [
              { id: "inv", class: "Invoice", target: "src/billing/domain/Invoice.ts::Invoice", metrics: {} },
              { id: "inv", class: "Invoice2", target: "src/billing/domain/Invoice2.ts::Invoice2", metrics: {} },
            ],
          },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.aggregate_roots[*].id");
    expect(err).toBeDefined();
    expect(err!.message).toContain("unique");
  });

  it("fails when invariant IDs are duplicated", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          { id: "billing", name: "Billing", subdomain_type: "core", root: "src/billing", layers: {} },
        ],
        core_invariants: [
          { id: "inv1", description: "A", evolvability: "never", status: "pending" },
          { id: "inv1", description: "B", evolvability: "never", status: "pending" },
        ],
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "ddd.core_invariants[*].id");
    expect(err).toBeDefined();
    expect(err!.message).toContain("unique");
  });

  it("fails when branded_id IDs are duplicated", () => {
    const profile = {
      ...minimalProfile(),
      type_driven: {
        enabled: true,
        branded_ids: {
          mode: "core_ids_only",
          declarations: [
            { id: "bid1", type_name: "InvoiceId", type_target: "src/billing/ids.ts::InvoiceId" },
            { id: "bid1", type_name: "CustomerId", type_target: "src/customer/ids.ts::CustomerId" },
          ],
        },
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "type_driven.branded_ids[*].id");
    expect(err).toBeDefined();
    expect(err!.message).toContain("unique");
  });

  it("passes when all IDs are unique", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          { id: "billing", name: "Billing", subdomain_type: "core", root: "src/billing", layers: {} },
          { id: "customer", name: "Customer", subdomain_type: "supporting", root: "src/customer", layers: {} },
        ],
        core_invariants: [
          { id: "inv1", description: "A", evolvability: "never", status: "pending" },
          { id: "inv2", description: "B", evolvability: "never", status: "pending" },
        ],
      },
      type_driven: {
        enabled: true,
        branded_ids: {
          mode: "core_ids_only",
          declarations: [
            { id: "bid1", type_name: "InvoiceId", type_target: "src/billing/ids.ts::InvoiceId" },
            { id: "bid2", type_name: "CustomerId", type_target: "src/customer/ids.ts::CustomerId" },
          ],
        },
      },
    } as DesignProfile;
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.message.includes("unique"));
    expect(err).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Closeout 3a — aggregate_members coherence
// ---------------------------------------------------------------------------

describe("aggregate_members coherence (Closeout 3a)", () => {
  it("rejects a required_method that is not in aggregate_members or the target name", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "core",
            name: "Core",
            subdomain_type: "core",
            root: "src/core",
            layers: {},
            aggregate_roots: [
              {
                id: "check-orchestrator",
                class: "CheckOrchestrator",
                target: "src/core/check.ts::runCheck",
                required_methods: ["runCheck", "prepareContext", "renamedSibling"],
                aggregate_members: ["prepareContext"],
                metrics: {},
              },
            ],
          },
        ],
      },
    } as unknown as DesignProfile;
    const errors = validateProfile(profile);
    const offending = errors.find((e) =>
      e.field === "ddd.contexts.core.aggregate_roots.check-orchestrator.required_methods" &&
      e.message.includes("renamedSibling"),
    );
    expect(offending).toBeDefined();
  });

  it("rejects a required_field that is not in aggregate_members or the target name", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "core",
            name: "Core",
            subdomain_type: "core",
            root: "src/core",
            layers: {},
            aggregate_roots: [
              {
                id: "loader",
                class: "Loader",
                target: "src/core/load.ts::loadContract",
                required_methods: ["loadContract"],
                required_fields: ["CACHE_SLAB"],
                aggregate_members: ["DEFAULT_PATH"],
                metrics: {},
              },
            ],
          },
        ],
      },
    } as unknown as DesignProfile;
    const errors = validateProfile(profile);
    const offending = errors.find((e) =>
      e.field === "ddd.contexts.core.aggregate_roots.loader.required_fields" &&
      e.message.includes("CACHE_SLAB"),
    );
    expect(offending).toBeDefined();
  });

  it("accepts required_methods that all appear in aggregate_members plus the target name", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "core",
            name: "Core",
            subdomain_type: "core",
            root: "src/core",
            layers: {},
            aggregate_roots: [
              {
                id: "check-orchestrator",
                class: "CheckOrchestrator",
                target: "src/core/check.ts::runCheck",
                required_methods: ["runCheck", "prepareContext"],
                aggregate_members: ["prepareContext", "runCheckImpl"],
                metrics: {},
              },
            ],
          },
        ],
      },
    } as unknown as DesignProfile;
    const errors = validateProfile(profile);
    const offending = errors.find((e) =>
      e.field.endsWith(".required_methods") || e.field.endsWith(".required_fields"),
    );
    expect(offending).toBeUndefined();
  });

  it("skips the aggregate-members check when aggregate_members is empty (back-compat with class targets)", () => {
    const profile = {
      ...minimalProfile(),
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "core",
            name: "Core",
            subdomain_type: "core",
            root: "src/core",
            layers: {},
            aggregate_roots: [
              {
                id: "registry",
                class: "InMemoryOperatorRegistry",
                target: "src/core/registry.ts::InMemoryOperatorRegistry",
                required_methods: ["register", "get", "has"],
                required_fields: ["#operators"],
                metrics: {},
              },
            ],
          },
        ],
      },
    } as unknown as DesignProfile;
    const errors = validateProfile(profile);
    const offending = errors.find((e) =>
      e.field.endsWith(".required_methods") || e.field.endsWith(".required_fields"),
    );
    expect(offending).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full profile round-trip through YAML
// ---------------------------------------------------------------------------

describe("full profile YAML round-trip", () => {
  it("loads a complete profile from YAML", async () => {
    const dir = await createTempDir();
    const profile: DesignProfile = {
      schema_version: 1,
      kind: "stele-design-profile",
      profile_id: "ddd-typedriven",
      created_at: "2026-05-19T00:00:00.000Z",
      updated_at: "2026-05-19T00:00:00.000Z",
      project: {
        language: "typescript",
        source_roots: ["src"],
        ignore: ["src/generated/**/*"],
        tsconfig: "tsconfig.json",
      },
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            decision_ref: "q1",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            architecture_style: "domain_model",
            layers: {
              api: "src/billing/api/**/*.ts",
              domain: "src/billing/domain/**/*.ts",
            },
          },
        ],
      },
      type_driven: {
        enabled: true,
        branded_ids: {
          mode: "core_ids_only",
          declarations: [
            { id: "invoice-id", type_name: "InvoiceId", type_target: "src/billing/domain/InvoiceId.ts::InvoiceId" },
          ],
        },
      },
    };
    await writeProfile(dir, profile);

    const loaded = loadProfile(dir);
    expect(loaded.schema_version).toBe(1);
    expect(loaded.profile_id).toBe("ddd-typedriven");
    expect(loaded.project!.language).toBe("typescript");
    expect(loaded.ddd!.contexts![0].id).toBe("billing");
    expect(loaded.ddd!.contexts![0].subdomain_type).toBe("core");
    expect(loaded.type_driven!.branded_ids!.declarations![0].type_name).toBe("InvoiceId");
  });

  it("validates a full profile with no errors", async () => {
    const profile: DesignProfile = {
      schema_version: 1,
      kind: "stele-design-profile",
      profile_id: "full",
      created_at: "2026-05-19T00:00:00.000Z",
      updated_at: "2026-05-19T00:00:00.000Z",
      decisions: [
        {
          id: "q1",
          question_id: "Q1",
          selected_option: "by_business_function",
          rationale: "Test",
          approved_by: "human",
          approved_at: "2026-05-19T00:00:00.000Z",
        },
      ],
      project: {
        language: "typescript",
        source_roots: ["src"],
        ignore: ["src/generated/**/*"],
        tsconfig: "tsconfig.json",
      },
      ddd: {
        bounded_context_strategy: "by_business_function",
        contexts: [
          {
            id: "billing",
            decision_ref: "q1",
            name: "Billing",
            subdomain_type: "core",
            root: "src/billing",
            architecture_style: "domain_model",
            layers: {
              api: "src/billing/api/**/*.ts",
              domain: "src/billing/domain/**/*.ts",
            },
          },
          {
            id: "customer",
            name: "Customer",
            subdomain_type: "supporting",
            root: "src/customer",
            layers: {
              public: "src/customer/public/**/*.ts",
            },
          },
        ],
        integrations: [
          {
            from: "billing",
            to: "customer",
            pattern: "anti_corruption_layer",
          },
        ],
        core_invariants: [
          {
            id: "inv1",
            description: "Invoice total non-negative",
            evolvability: "never",
            status: "pending",
          },
        ],
      },
      type_driven: {
        enabled: true,
        branded_ids: {
          mode: "core_ids_only",
          declarations: [
            { id: "invoice-id", type_name: "InvoiceId", type_target: "src/billing/ids.ts::InvoiceId" },
          ],
        },
      },
      toolchain_contracts: {
        typescript_diagnostics: {
          enabled: true,
          command: "pnpm tsc --noEmit",
        },
      },
    };

    const errors = validateProfile(profile);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hash utilities
// ---------------------------------------------------------------------------

describe("hash utilities", () => {
  it("hashString produces consistent SHA-256 hex digest", () => {
    const hash = hashString("hello world");
    expect(typeof hash).toBe("string");
    expect(hash).toHaveLength(64);
    // Deterministic: calling twice produces the same hash
    expect(hashString("hello world")).toBe(hash);
  });

  it("hashFile produces consistent SHA-256 hex digest", async () => {
    const dir = await createTempDir();
    const filePath = join(dir, "test.txt");
    await writeFile(filePath, "hash me", "utf8");

    const hash = hashFile(filePath);
    expect(typeof hash).toBe("string");
    expect(hash).toHaveLength(64);

    // Calling again should produce the same hash
    expect(hashFile(filePath)).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Deprecation: type_driven.adt (Phase B removal)
// ---------------------------------------------------------------------------

describe("type_driven.adt — deprecated field", () => {
  it("parses successfully when adt is absent (no notice)", async () => {
    const dir = await createTempDir();
    await writeProfile(dir, minimalProfile());

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const profile = loadProfile(dir);
      expect(profile.type_driven).toBeUndefined();
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }

    const combined = writes.join("");
    expect(combined).not.toContain("adt-deprecated");
  });

  it("parses successfully with adt: { mode: hard } and emits a deprecation notice (no error)", async () => {
    const dir = await createTempDir();
    const profile: DesignProfile = {
      ...minimalProfile(),
      type_driven: {
        enabled: true,
        adt: { mode: "hard" },
      },
    };
    await writeProfile(dir, profile);

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let loaded: DesignProfile | undefined;
    try {
      loaded = loadProfile(dir);
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }

    expect(loaded).toBeDefined();
    expect(loaded!.type_driven?.adt?.mode).toBe("hard");

    const combined = writes.join("");
    expect(combined).toContain("[notice] design-profile.adt-deprecated");
    expect(combined).toContain("'type_driven.adt'");
    expect(combined).toContain("v0.4");
  });

  it("validateProfile silently accepts adt with malformed entities (back-compat)", () => {
    const profile: DesignProfile = {
      ...minimalProfile(),
      type_driven: {
        enabled: true,
        adt: {
          mode: "hard",
          entities: [
            // Malformed type_target previously would have produced a validation error;
            // it must now be silently ignored.
            { name: "Bad", type_target: "not-a-valid-format" },
          ],
        },
      },
    };
    const errors = validateProfile(profile);
    const adtErrors = errors.filter((e) => e.field.startsWith("type_driven.adt"));
    expect(adtErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase B T3.4 — trace section
// ---------------------------------------------------------------------------

describe("trace section", () => {
  function withTrace(policies: unknown[]): DesignProfile {
    return {
      ...minimalProfile(),
      // Cast through unknown to allow tests to inject malformed inputs.
      trace: { policies } as unknown as DesignProfile["trace"],
    };
  }

  it("profile without trace section parses cleanly (no notices)", async () => {
    const dir = await createTempDir();
    await writeProfile(dir, minimalProfile());

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let loaded: DesignProfile | undefined;
    try {
      loaded = loadProfile(dir);
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }
    expect(loaded).toBeDefined();
    expect(loaded!.trace).toBeUndefined();
    expect(writes.join("")).not.toContain("trace-fix-hint-vague");
  });

  it("profile with a valid trace section parses cleanly", () => {
    const profile = withTrace([
      {
        id: "DB_VIA_REPOSITORY",
        description: "All DB access via repository",
        severity: "error",
        target: ["**/db/**::*"],
        must_transit: ["**/repository/**::*"],
        fix_hint: "Use `Repository.find` at src/db.ts:42",
      },
    ]);
    const errors = validateProfile(profile);
    expect(errors).toEqual([]);
  });

  it("policy missing id → validation error", () => {
    const profile = withTrace([
      {
        target: ["**/db/**::*"],
        must_transit: ["**/repo/**::*"],
      },
    ]);
    const errors = validateProfile(profile);
    const idErr = errors.find((e) => e.field.endsWith(".id"));
    expect(idErr).toBeDefined();
    expect(idErr!.message).toContain("missing id");
  });

  it("policy missing target → validation error", () => {
    const profile = withTrace([
      {
        id: "BAD",
        must_transit: ["**/repo/**::*"],
      },
    ]);
    const errors = validateProfile(profile);
    const tErr = errors.find((e) => e.field === "trace.policies[BAD].target");
    expect(tErr).toBeDefined();
    expect(tErr!.message).toContain("non-empty array");
  });

  it("policy with no must-* / deny-* constraints → validation error", () => {
    const profile = withTrace([
      {
        id: "NO_RULE",
        target: ["**/db/**::*"],
      },
    ]);
    const errors = validateProfile(profile);
    const err = errors.find(
      (e) => e.field === "trace.policies[NO_RULE]" && e.message.includes("must declare at least one"),
    );
    expect(err).toBeDefined();
  });

  it("policy with bad pattern (trailing ::) → validation error (E0335-equivalent)", () => {
    const profile = withTrace([
      {
        id: "BAD_PAT",
        target: ["**/db/**::"],
        must_transit: ["**/repo/**::*"],
      },
    ]);
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field.startsWith("trace.policies[BAD_PAT].target"));
    expect(err).toBeDefined();
    expect(err!.message).toContain('trailing "::"');
  });

  it("policy with vague fix-hint → notice (not error)", async () => {
    const dir = await createTempDir();
    const profile: DesignProfile = {
      ...minimalProfile(),
      trace: {
        policies: [
          {
            id: "DEMO",
            target: ["**/db/**::*"],
            must_transit: ["**/repo/**::*"],
            fix_hint: "be careful", // no backticks, no file:line
          },
        ],
      },
    };
    await writeProfile(dir, profile);

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let loaded: DesignProfile | undefined;
    try {
      loaded = loadProfile(dir);
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }

    expect(loaded).toBeDefined();
    const combined = writes.join("");
    expect(combined).toContain("[notice] design-profile.trace-fix-hint-vague");
    expect(combined).toContain("trace.policies[DEMO].fix_hint");
    // and not an error — load succeeded
    expect(loaded!.trace?.policies[0]?.id).toBe("DEMO");
  });

  it("exempt entry missing reason → validation error", () => {
    const profile = withTrace([
      {
        id: "BAD_EX",
        target: ["**/db/**::*"],
        must_transit: ["**/repo/**::*"],
        exempt: [{ pattern: "**/legacy/**::*" }],
      },
    ]);
    const errors = validateProfile(profile);
    const err = errors.find(
      (e) => e.field === "trace.policies[BAD_EX].exempt[0].reason",
    );
    expect(err).toBeDefined();
  });

  it('severity "info" → validation error', () => {
    const profile = withTrace([
      {
        id: "BAD_SEV",
        severity: "info",
        target: ["**/db/**::*"],
        must_transit: ["**/repo/**::*"],
      },
    ]);
    const errors = validateProfile(profile);
    const err = errors.find((e) => e.field === "trace.policies[BAD_SEV].severity");
    expect(err).toBeDefined();
    expect(err!.message).toContain('"error" or "warning"');
  });

  it("duplicate policy ids → validation error", () => {
    const profile = withTrace([
      { id: "DUP", target: ["**/a/**::*"], must_transit: ["**/r/**::*"] },
      { id: "DUP", target: ["**/b/**::*"], deny_direct: ["**/c/**::*"] },
    ]);
    const errors = validateProfile(profile);
    expect(errors.some((e) => e.message.includes("duplicate trace policy id"))).toBe(true);
  });
});
