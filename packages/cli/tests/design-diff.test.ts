import { describe, expect, it } from "vitest";
import type { DesignProfile } from "../src/design-profile/types.js";
import { computeDesignDiff, type ChangeClass, type DesignDiffResult } from "../src/commands/design/diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseProfile(): DesignProfile {
  return {
    schema_version: 1,
    kind: "stele-design-profile",
    profile_id: "test-diff",
    created_at: "2026-05-19T00:00:00.000Z",
    updated_at: "2026-05-19T00:00:00.000Z",
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: ["src/generated/**/*"],
    },
    ddd: {
      bounded_context_strategy: "by_business_function",
      contexts: [
        {
          id: "billing",
          name: "Billing",
          subdomain_type: "core",
          root: "src/billing",
          layers: {
            domain: "src/billing/domain/**/*.ts",
            api: "src/billing/api/**/*.ts",
          },
          aggregate_roots: [
            {
              id: "invoice",
              class: "Invoice",
              target: "src/billing/domain/Invoice.ts::Invoice",
              metrics: {
                sloc: { ideal: 50, max: 150 },
                "max-cyclomatic": { ideal: 5, max: 10 },
              },
            },
          ],
        },
        {
          id: "customer",
          name: "Customer",
          subdomain_type: "supporting",
          root: "src/customer",
          layers: {
            domain: "src/customer/domain/**/*.ts",
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
          id: "inv-total-non-negative",
          description: "Invoice total must be non-negative",
          evolvability: "never",
          status: "enforced",
        },
      ],
    },
    type_driven: {
      enabled: true,
      branded_ids: {
        mode: "core_ids_only",
        declarations: [
          {
            id: "invoice-id",
            type_name: "InvoiceId",
            type_target: "src/billing/domain/InvoiceId.ts::InvoiceId",
          },
        ],
      },
    },
    toolchain_contracts: {
      typescript_diagnostics: {
        enabled: true,
        command: "pnpm tsc --noEmit",
      },
      eslint: {
        enabled: true,
        format: "json",
        rules: ["no-unused-vars", "no-eval"],
      },
    },
  };
}

function findChange(
  result: DesignDiffResult,
  fieldPredicate: (c: { field: string }) => boolean,
): import("../src/commands/design/diff.js").DesignDiffChange | undefined {
  return result.changes.find(fieldPredicate);
}

// ---------------------------------------------------------------------------
// No changes
// ---------------------------------------------------------------------------

describe("computeDesignDiff — no changes", () => {
  it("returns empty diff when profiles are identical", () => {
    const profile = baseProfile();
    const result = computeDesignDiff(profile, profile);

    expect(result.changes).toEqual([]);
    expect(result.overallClass).toBe("additive");
    expect(result.hasWeakening).toBe(false);
    expect(result.hasRestructuring).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adding new context → additive, requires approval
// ---------------------------------------------------------------------------

describe("computeDesignDiff — adding new context", () => {
  it("classifies adding a new context as additive requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: [
          ...(old.ddd!.contexts ?? []),
          {
            id: "payments",
            name: "Payments",
            subdomain_type: "core",
            root: "src/payments",
            layers: {
              domain: "src/payments/domain/**/*.ts",
            },
          },
        ],
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "ddd.contexts.payments");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("additive");
    expect(change!.requiresApproval).toBe(true);
    expect(change!.description).toContain("Payments");
    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Removing context → weakening, requires approval
// ---------------------------------------------------------------------------

describe("computeDesignDiff — removing context", () => {
  it("classifies removing a context as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: (old.ddd!.contexts ?? []).filter((c) => c.id !== "customer"),
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "ddd.contexts.customer");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.requiresApproval).toBe(true);
    expect(change!.description).toContain("Customer");
    expect(result.hasWeakening).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Relaxing metric max → weakening, requires approval
// ---------------------------------------------------------------------------

describe("computeDesignDiff — relaxing metric max", () => {
  it("classifies increasing metric max as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: (old.ddd!.contexts ?? []).map((c) => {
          if (c.id === "billing") {
            return {
              ...c,
              aggregate_roots: c.aggregate_roots!.map((a) => {
                if (a.id === "invoice") {
                  return {
                    ...a,
                    metrics: {
                      ...a.metrics,
                      sloc: { ideal: 50, max: 300 }, // increased from 150
                    },
                  };
                }
                return a;
              }),
            };
          }
          return c;
        }),
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) =>
      c.field.includes("invoice") && c.field.includes("sloc") && c.field.includes("max"),
    );

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.oldValue).toBe("150");
    expect(change!.newValue).toBe("300");
    expect(change!.requiresApproval).toBe(true);
    expect(result.hasWeakening).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tightening metric max → tightening
// ---------------------------------------------------------------------------

describe("computeDesignDiff — tightening metric max", () => {
  it("classifies decreasing metric max as tightening without approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: (old.ddd!.contexts ?? []).map((c) => {
          if (c.id === "billing") {
            return {
              ...c,
              aggregate_roots: c.aggregate_roots!.map((a) => {
                if (a.id === "invoice") {
                  return {
                    ...a,
                    metrics: {
                      ...a.metrics,
                      sloc: { ideal: 50, max: 100 }, // decreased from 150
                    },
                  };
                }
                return a;
              }),
            };
          }
          return c;
        }),
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) =>
      c.field.includes("invoice") && c.field.includes("sloc") && c.field.includes("max"),
    );

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("tightening");
    expect(change!.oldValue).toBe("150");
    expect(change!.newValue).toBe("100");
    expect(change!.requiresApproval).toBe(false);
    expect(result.hasWeakening).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moving context root → restructuring, requires approval
// ---------------------------------------------------------------------------

describe("computeDesignDiff — moving context root", () => {
  it("classifies changing context root as restructuring requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: (old.ddd!.contexts ?? []).map((c) => {
          if (c.id === "billing") {
            return { ...c, root: "src/new/billing" };
          }
          return c;
        }),
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "ddd.contexts.billing.root");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("restructuring");
    expect(change!.oldValue).toBe("src/billing");
    expect(change!.newValue).toBe("src/new/billing");
    expect(change!.requiresApproval).toBe(true);
    expect(result.hasRestructuring).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adding allow-dependency integration → additive, requires approval
// ---------------------------------------------------------------------------

describe("computeDesignDiff — adding integration (allow-dependency)", () => {
  it("classifies adding a new integration as additive requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        integrations: [
          ...(old.ddd!.integrations ?? []),
          {
            from: "billing",
            to: "payments",
            pattern: "published_language",
          },
        ],
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field.includes("billing") && c.field.includes("payments"));

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("additive");
    expect(change!.requiresApproval).toBe(true);
    expect(change!.description).toContain("billing");
    expect(change!.description).toContain("payments");
  });
});

// ---------------------------------------------------------------------------
// Adding pending invariant → additive, no approval needed
// ---------------------------------------------------------------------------

describe("computeDesignDiff — adding pending invariant", () => {
  it("classifies adding a pending invariant as additive without approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        core_invariants: [
          ...(old.ddd!.core_invariants ?? []),
          {
            id: "inv-customer-email-unique",
            description: "Customer email must be unique",
            evolvability: "with-review",
            status: "pending",
          },
        ],
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "ddd.core_invariants.inv-customer-email-unique");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("additive");
    expect(change!.requiresApproval).toBe(false);
    expect(change!.description).toContain("inv-customer-email-unique");
  });
});

// ---------------------------------------------------------------------------
// Removing core invariant → weakening, requires approval
// ---------------------------------------------------------------------------

describe("computeDesignDiff — removing core invariant", () => {
  it("classifies removing an invariant as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        core_invariants: [],
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "ddd.core_invariants.inv-total-non-negative");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.requiresApproval).toBe(true);
    expect(result.hasWeakening).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Aggregate root changes
// ---------------------------------------------------------------------------

describe("computeDesignDiff — adding aggregate root", () => {
  it("classifies adding a new aggregate root as additive requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: (old.ddd!.contexts ?? []).map((c) => {
          if (c.id === "billing") {
            return {
              ...c,
              aggregate_roots: [
                ...(c.aggregate_roots ?? []),
                {
                  id: "payment",
                  class: "Payment",
                  target: "src/billing/domain/Payment.ts::Payment",
                  metrics: {},
                },
              ],
            };
          }
          return c;
        }),
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "ddd.contexts.billing.aggregate_roots.payment");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("additive");
    expect(change!.requiresApproval).toBe(true);
  });
});

describe("computeDesignDiff — moving aggregate target", () => {
  it("classifies moving an aggregate target as restructuring requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: (old.ddd!.contexts ?? []).map((c) => {
          if (c.id === "billing") {
            return {
              ...c,
              aggregate_roots: c.aggregate_roots!.map((a) => {
                if (a.id === "invoice") {
                  return { ...a, target: "src/billing/domain/InvoiceV2.ts::Invoice" };
                }
                return a;
              }),
            };
          }
          return c;
        }),
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "ddd.contexts.billing.aggregate_roots.invoice.target");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("restructuring");
    expect(change!.oldValue).toBe("src/billing/domain/Invoice.ts::Invoice");
    expect(change!.newValue).toBe("src/billing/domain/InvoiceV2.ts::Invoice");
    expect(change!.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Branded ID changes
// ---------------------------------------------------------------------------

describe("computeDesignDiff — adding branded ID with explicit target", () => {
  it("classifies adding a branded ID as additive without approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      type_driven: {
        ...old.type_driven!,
        branded_ids: {
          ...old.type_driven!.branded_ids!,
          declarations: [
            ...(old.type_driven!.branded_ids!.declarations ?? []),
            {
              id: "customer-id",
              type_name: "CustomerId",
              type_target: "src/customer/domain/CustomerId.ts::CustomerId",
            },
          ],
        },
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "type_driven.branded_ids.customer-id");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("additive");
    expect(change!.requiresApproval).toBe(false); // explicit target
  });
});

// ---------------------------------------------------------------------------
// Removing branded ID → weakening
// ---------------------------------------------------------------------------

describe("computeDesignDiff — removing branded ID", () => {
  it("classifies removing a branded ID as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      type_driven: {
        ...old.type_driven!,
        branded_ids: {
          ...old.type_driven!.branded_ids!,
          declarations: [],
        },
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "type_driven.branded_ids.invoice-id");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Toolchain contract changes
// ---------------------------------------------------------------------------

describe("computeDesignDiff — disabling type-driven", () => {
  it("classifies disabling type-driven as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      type_driven: {
        ...old.type_driven!,
        enabled: false,
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "type_driven.enabled");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.requiresApproval).toBe(true);
  });
});

describe("computeDesignDiff — disabling ESLint", () => {
  it("classifies disabling ESLint as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      toolchain_contracts: {
        ...old.toolchain_contracts!,
        eslint: {
          ...old.toolchain_contracts!.eslint!,
          enabled: false,
          format: "json",
          rules: [],
        },
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "toolchain_contracts.eslint.enabled");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.requiresApproval).toBe(true);
  });
});

describe("computeDesignDiff — adding ESLint rule", () => {
  it("classifies adding an ESLint rule as tightening without approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      toolchain_contracts: {
        ...old.toolchain_contracts!,
        eslint: {
          ...old.toolchain_contracts!.eslint!,
          rules: [...old.toolchain_contracts!.eslint!.rules!, "no-console"],
        },
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "toolchain_contracts.eslint.rules.no-console");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("tightening");
    expect(change!.requiresApproval).toBe(false);
  });
});

describe("computeDesignDiff — removing ESLint rule", () => {
  it("classifies removing an ESLint rule as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      toolchain_contracts: {
        ...old.toolchain_contracts!,
        eslint: {
          ...old.toolchain_contracts!.eslint!,
          rules: ["no-eval"], // removed "no-unused-vars"
        },
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "toolchain_contracts.eslint.rules.no-unused-vars");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source root removal → weakening
// ---------------------------------------------------------------------------

describe("computeDesignDiff — removing source root", () => {
  it("classifies removing a source root as weakening requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      project: {
        ...old.project!,
        source_roots: [],
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field === "project.source_roots.src");

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("weakening");
    expect(change!.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Overall severity classification
// ---------------------------------------------------------------------------

describe("computeDesignDiff — overall class severity", () => {
  it("returns the most severe class when multiple change types exist", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      // Add a new context (additive)
      ddd: {
        ...old.ddd!,
        contexts: [
          ...(old.ddd!.contexts ?? []),
          {
            id: "new-ctx",
            name: "New",
            subdomain_type: "generic",
            root: "src/new",
            layers: {},
          },
        ],
        // Remove an invariant (weakening)
        core_invariants: [],
      },
      // Relax metric (weakening)
      type_driven: {
        ...old.type_driven!,
        enabled: false, // weakening
      },
    };

    const result = computeDesignDiff(old, newP);
    expect(result.overallClass).toBe("weakening");
    expect(result.hasWeakening).toBe(true);
    expect(result.requiresApproval).toBe(true);
  });

  it("returns restructuring when context root is moved", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        contexts: (old.ddd!.contexts ?? []).map((c) => {
          if (c.id === "billing") {
            return { ...c, root: "src/renamed-billing" };
          }
          return c;
        }),
      },
    };

    const result = computeDesignDiff(old, newP);
    expect(result.overallClass).toBe("restructuring");
    expect(result.hasRestructuring).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration pattern change → restructuring
// ---------------------------------------------------------------------------

describe("computeDesignDiff — changing integration pattern", () => {
  it("classifies changing integration pattern as restructuring requiring approval", () => {
    const old = baseProfile();
    const newP: DesignProfile = {
      ...old,
      ddd: {
        ...old.ddd!,
        integrations: [
          {
            from: "billing",
            to: "customer",
            pattern: "open_host_service", // changed from anti_corruption_layer
          },
        ],
      },
    };

    const result = computeDesignDiff(old, newP);
    const change = findChange(result, (c) => c.field.includes(".pattern"));

    expect(change).toBeDefined();
    expect(change!.changeClass).toBe("restructuring");
    expect(change!.oldValue).toBe("anti_corruption_layer");
    expect(change!.newValue).toBe("open_host_service");
    expect(change!.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty profile sections
// ---------------------------------------------------------------------------

describe("computeDesignDiff — empty profile sections", () => {
  it("handles profiles with no ddd section", () => {
    const old: DesignProfile = {
      schema_version: 1,
      kind: "stele-design-profile",
      profile_id: "empty",
      created_at: "2026-05-19T00:00:00.000Z",
      updated_at: "2026-05-19T00:00:00.000Z",
      project: {
        language: "typescript",
        source_roots: ["src"],
        ignore: [],
      },
    };

    const result = computeDesignDiff(old, old);
    expect(result.changes).toEqual([]);
    expect(result.requiresApproval).toBe(false);
  });

  it("handles adding ddd section to empty profile", () => {
    const old: DesignProfile = {
      schema_version: 1,
      kind: "stele-design-profile",
      profile_id: "empty",
      created_at: "2026-05-19T00:00:00.000Z",
      updated_at: "2026-05-19T00:00:00.000Z",
      project: {
        language: "typescript",
        source_roots: ["src"],
        ignore: [],
      },
    };

    const newP = baseProfile();
    const result = computeDesignDiff(old, newP);

    // Should detect added contexts
    const ctxChanges = result.changes.filter(
      (c) => c.field.startsWith("ddd.contexts.") && c.changeClass === "additive",
    );
    expect(ctxChanges.length).toBeGreaterThanOrEqual(2); // billing and customer added
    expect(result.requiresApproval).toBe(true);
  });
});
