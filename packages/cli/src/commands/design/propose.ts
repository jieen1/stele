import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

import { computeDesignDiff } from "./diff.js";
import type { AggregateRoot, BrandedId, Context, CoreInvariant, DesignProfile } from "../../design-profile/types.js";
import { loadProfile } from "../../design-profile/load.js";

export type DesignProposeOptions = {
  id?: string;
  description?: string;
  evolvability?: string;
  typeName?: string;
  target?: string;
};

export async function runDesignPropose(
  proposalType: string,
  opts: DesignProposeOptions,
  projectDir: string = process.cwd(),
): Promise<void> {
  if (!opts.id) {
    process.stderr.write("[design] --id is required\n");
    process.exitCode = 1;
    return;
  }

  // Validate: proposal is add-only (no modifications or removals)
  const profile = await loadProfile(projectDir);

  // Check for duplicate id in existing profile entries
  if (proposalType === "invariant") {
    const existing = profile.ddd?.core_invariants?.find((inv) => inv.id === opts.id);
    if (existing) {
      process.stderr.write(`[design] Invariant "${opts.id}" already exists in profile\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (proposalType === "branded-id") {
    const existing = profile.type_driven?.branded_ids?.declarations?.find((d) => d.id === opts.id);
    if (existing) {
      process.stderr.write(`[design] Branded ID "${opts.id}" already exists in profile\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (proposalType === "aggregate") {
    for (const ctx of profile.ddd?.contexts ?? []) {
      const existing = ctx.aggregate_roots?.find((agg) => agg.id === opts.id);
      if (existing) {
        process.stderr.write(`[design] Aggregate "${opts.id}" already exists in profile\n`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // Write proposal file
  const proposalsDir = resolve(projectDir, "contract/design/proposals");
  mkdirSync(proposalsDir, { recursive: true });

  // Check for duplicate in existing proposals
  if (existsSync(proposalsDir)) {
    const files = readdirSync(proposalsDir).filter((f) => f.endsWith(".yaml"));
    for (const file of files) {
      const raw = readFileSync(resolve(proposalsDir, file), "utf8");
      const parsed = yaml.parse(raw) as Record<string, unknown>;
      if (String(parsed.id) === opts.id && String(parsed.kind) === proposalType) {
        process.stderr.write(`[design] Proposal "${opts.id}" (kind: ${proposalType}) already exists in proposals/\n`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 22);
  const filePath = resolve(proposalsDir, `${ts}-${opts.id}.yaml`);

  const content: Record<string, unknown> = {
    id: opts.id,
    kind: proposalType,
    created_at: new Date().toISOString(),
  };

  if (proposalType === "invariant") {
    content.description = opts.description ?? "";
    content.evolvability = opts.evolvability ?? "never";
  }

  if (proposalType === "branded-id") {
    content.type_name = opts.typeName ?? opts.id;
    content.target = opts.target ?? "";
  }

  if (proposalType === "aggregate") {
    content.description = opts.description ?? "";
    content.target = opts.target ?? "";
  }

  writeFileSync(filePath, yaml.stringify(content), "utf8");

  // Validate: run diff to prove the proposal is additive (no weakening or restructuring)
  const currentProfile = await loadProfile(projectDir);
  const mergedProfile = mergeProposalIntoProfile(currentProfile, proposalType, content);
  const diff = computeDesignDiff(currentProfile, mergedProfile);

  if (diff.hasWeakening || diff.hasRestructuring) {
    const badChanges = diff.changes.filter(
      (c) => c.changeClass === "weakening" || c.changeClass === "restructuring",
    );
    process.stderr.write(
      `[design] Proposal "${opts.id}" (${proposalType}) rejected: contains non-additive changes:\n`,
    );
    for (const c of badChanges) {
      process.stderr.write(`  [${c.changeClass}] ${c.description}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`[design] Proposal "${opts.id}" (${proposalType}) written to ${filePath}\n`);
}

// ---------------------------------------------------------------------------
// Proposal merge helper
// ---------------------------------------------------------------------------

/**
 * Merge a proposal into a copy of the current profile, producing a hypothetical
 * "post-proposal" profile. Used with computeDesignDiff to verify additivity.
 */
function mergeProposalIntoProfile(
  current: DesignProfile,
  proposalType: string,
  content: Record<string, unknown>,
): DesignProfile {
  const merged: DesignProfile = {
    ...current,
    updated_at: new Date().toISOString(),
    project: { ...current.project },
    ddd: current.ddd ? { ...current.ddd } : undefined,
    type_driven: current.type_driven ? { ...current.type_driven } : undefined,
    toolchain_contracts: current.toolchain_contracts
      ? { ...current.toolchain_contracts }
      : undefined,
  };

  if (proposalType === "invariant") {
    const ddd = merged.ddd!;
    const inv = {
      id: String(content.id),
      description: String(content.description ?? ""),
      evolvability: String(content.evolvability ?? "never"),
      status: "pending",
    } as CoreInvariant;
    merged.ddd = {
      ...ddd,
      core_invariants: [...(ddd.core_invariants ?? []), inv],
    };
  }

  if (proposalType === "branded-id") {
    const td = merged.type_driven!;
    const bid = {
      id: String(content.id),
      type_name: String(content.type_name ?? content.id),
      type_target: String(content.target ?? ""),
    } as BrandedId;
    merged.type_driven = {
      ...td,
      branded_ids: {
        ...(td.branded_ids ?? { mode: "explicit" }),
        declarations: [
          ...(td.branded_ids?.declarations ?? []),
          bid,
        ],
      },
    };
  }

  if (proposalType === "aggregate") {
    const ddd = merged.ddd!;
    const newAgg = {
      id: String(content.id),
      class: String(content.id),
      target: String(content.target ?? ""),
      metrics: {},
    } as AggregateRoot;

    // Try to find an existing context with a matching aggregate class
    const contexts = [...(ddd.contexts ?? [])];
    let found = false;
    for (const ctx of contexts) {
      const existing = ctx.aggregate_roots?.find(
        (agg) => agg.class === String(content.id),
      );
      if (existing) {
        const updatedCtx: Context = {
          ...ctx,
          aggregate_roots: [
            ...(ctx.aggregate_roots ?? []),
            newAgg,
          ],
        };
        const idx = contexts.indexOf(ctx);
        contexts[idx] = updatedCtx;
        found = true;
        break;
      }
    }

    if (!found) {
      // No existing aggregate matches; the proposal is still additive
      // (it introduces a new aggregate). Attach to first context if possible.
      if (contexts.length > 0) {
        const first = contexts[0];
        contexts[0] = {
          ...first,
          aggregate_roots: [...(first.aggregate_roots ?? []), newAgg],
        };
      }
    }

    merged.ddd = {
      ...ddd,
      contexts,
    };
  }

  return merged;
}
