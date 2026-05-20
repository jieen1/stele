import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

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

  process.stdout.write(`[design] Proposal "${opts.id}" (${proposalType}) written to ${filePath}\n`);
}
