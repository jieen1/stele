import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import * as yaml from "js-yaml";
import type { Context, DesignProfile } from "../../design-profile/types.js";
import { profilePathExists } from "../../design-profile/load.js";
import { validateProfile } from "../../design-profile/validate.js";
import { runDesignGenerate } from "./generate.js";
import { runDesignApprove } from "./approve.js";
import { ExitCode } from "../../errors.js";

const DEFAULT_PROFILE_PATH = "contract/design/profile.yaml";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type DesignInitOptions = {
  preset?: string;
  answers?: string;
  dryRun?: boolean;
  generate?: boolean;
  replace?: boolean;
};

// ---------------------------------------------------------------------------
// Profile template factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid design profile for the given preset.
 * Only "ddd-typedriven" is supported at this time.
 */
function buildTemplate(preset: string): DesignProfile {
  if (preset !== "ddd-typedriven") {
    process.stderr.write(
      `[design:init] Unsupported preset "${preset}". Supported: ddd-typedriven\n`,
    );
    process.exitCode = ExitCode.USER_ERROR;
    // Return a dummy profile so the caller can exit gracefully.
    // The non-zero exitCode signals failure.
  }

  const now = new Date().toISOString();
  return {
    schema_version: 1,
    kind: "stele-design-profile",
    profile_id: preset,
    created_at: now,
    updated_at: now,
    decisions: [],
    project: {
      language: "typescript",
      source_roots: ["src"],
      ignore: [],
      tsconfig: "tsconfig.json",
    },
    ddd: {
      bounded_context_strategy: "by_business_function",
      contexts: [],
      shared_kernels: [],
      integrations: [],
    },
    type_driven: {
      enabled: false,
      branded_ids: {
        mode: "core_ids_only",
        declarations: [],
      },
      smart_constructors: {
        mode: "all_value_objects",
        value_objects: [],
      },
    },
    toolchain_contracts: {
      typescript_config: {
        required_options: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Answers merge
// ---------------------------------------------------------------------------

type Answers = {
  source_roots?: string[];
  contexts?: Array<{
    id: string;
    name: string;
    subdomain_type: "core" | "supporting" | "generic";
    root: string;
    aggregate_roots?: Array<{
      id: string;
      class: string;
      target: string;
      metrics?: Record<string, unknown>;
    }>;
  }>;
  aggregate_roots?: Record<
    string,
    Array<{
      id: string;
      class: string;
      target: string;
      metrics?: Record<string, unknown>;
    }>
  >;
  integrations?: Array<{
    from: string;
    to: string;
    pattern: "anti_corruption_layer" | "open_host_service" | "published_language";
    adapter_module?: string;
  }>;
  branded_ids?: Array<{
    id: string;
    type_name: string;
    type_target: string;
  }>;
};

/**
 * Load an answers YAML file and return parsed content.
 */
function loadAnswers(filePath: string, projectDir: string): Answers {
  const fullPath = resolve(projectDir, filePath);
  const text = readFileSync(fullPath, "utf8");
  return yaml.load(text, { schema: yaml.JSON_SCHEMA }) as Answers;
}

/**
 * Merge answers into the template profile. Answers override template defaults.
 * Returns a new profile object; the input is never mutated.
 */
function mergeAnswers(profile: DesignProfile, answers: Answers): DesignProfile {
  let result = { ...profile };

  // Source roots override
  if (answers.source_roots && answers.source_roots.length > 0) {
    result = {
      ...result,
      project: {
        ...result.project,
        source_roots: answers.source_roots,
      },
    };
  }

  // Bounded contexts
  if (answers.contexts && answers.contexts.length > 0) {
    const contexts = answers.contexts.map((ctx) => {
      const extraAggregates = answers.aggregate_roots?.[ctx.id] ?? [];
      return {
        id: ctx.id,
        name: ctx.name,
        subdomain_type: ctx.subdomain_type,
        root: ctx.root,
        layers: {},
        aggregate_roots: [
          ...(ctx.aggregate_roots ?? []),
          ...extraAggregates.map((ar) => ({
            id: ar.id,
            class: ar.class,
            target: ar.target,
            metrics: ar.metrics ?? {},
          })),
        ],
      };
    }) as Context[];

    if (result.ddd) {
      result = {
        ...result,
        ddd: {
          ...result.ddd,
          contexts,
        },
      };
    }
  }

  // Integrations
  if (answers.integrations && answers.integrations.length > 0) {
    if (result.ddd) {
      result = {
        ...result,
        ddd: {
          ...result.ddd,
          integrations: answers.integrations,
        },
      };
    }
  }

  // Branded IDs
  if (answers.branded_ids && answers.branded_ids.length > 0) {
    result = {
      ...result,
      type_driven: {
        ...result.type_driven,
        enabled: true,
        branded_ids: {
          mode: result.type_driven?.branded_ids?.mode ?? "core_ids_only",
          declarations: answers.branded_ids,
        },
      },
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Profile serialization
// ---------------------------------------------------------------------------

function profileToYaml(profile: DesignProfile): string {
  return yaml.dump(profile, {
    indent: 2,
    lineWidth: -1, // no line wrapping
    noRefs: true,
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDesignInit(
  opts: DesignInitOptions,
  projectDir = process.cwd(),
): Promise<void> {
  // 1. Validate preset
  if (!opts.preset) {
    process.stderr.write(
      "[design:init] --preset is required. Supported: ddd-typedriven\n",
    );
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }

  // 2. Check existing profile
  const profilePath = resolve(projectDir, DEFAULT_PROFILE_PATH);
  const exists = profilePathExists(projectDir);

  if (exists) {
    if (opts.replace) {
      process.stdout.write(
        "[design:init] WARNING: --replace flag used. Existing profile will be overwritten.\n" +
          "Review guidance: After init, run 'stele design check' to verify the new profile.\n" +
          "The generated contracts will drift until you run 'stele design generate'.\n",
      );
    } else {
      process.stderr.write(
        `[design:init] Profile already exists at ${DEFAULT_PROFILE_PATH}. Use --replace to overwrite.\n`,
      );
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
  }

  // 3. Build template profile
  let profile = buildTemplate(opts.preset);
  if (process.exitCode) return;

  // 4. Load and merge answers
  if (opts.answers) {
    if (!existsSync(resolve(projectDir, opts.answers))) {
      process.stderr.write(
        `[design:init] Answers file not found: ${opts.answers}\n`,
      );
      process.exitCode = ExitCode.USER_ERROR;
      return;
    }
    const answers = loadAnswers(opts.answers, projectDir);
    profile = mergeAnswers(profile, answers);
  }

  // 5. Validate profile
  const errors = validateProfile(profile);
  if (errors.length > 0) {
    process.stderr.write("[design:init] Generated profile has validation errors:\n");
    for (const err of errors) {
      process.stderr.write(`  ${err.field}: ${err.message}\n`);
    }
    process.exitCode = ExitCode.CONFIG_ERROR;
    return;
  }

  // 6. Serialize to YAML
  const yamlContent = profileToYaml(profile);

  // 7. Dry-run or write
  if (opts.dryRun) {
    process.stdout.write(`[design:init] Dry-run: would create ${DEFAULT_PROFILE_PATH}\n`);
    process.stdout.write(yamlContent);
  } else {
    mkdirSync(dirname(profilePath), { recursive: true });
    writeFileSync(profilePath, yamlContent, "utf8");
    process.stdout.write(
      `[design:init] Created ${DEFAULT_PROFILE_PATH} (preset: ${opts.preset})\n`,
    );
  }

  // 8. Run generate if requested.
  //
  // Round 4 D-03: previously this hard-coded `force: true` so init could
  // generate without an approval record. That was a second P0-4 bypass —
  // any agent running `stele design init --generate` via Bash created
  // contract files unilaterally. The new behaviour:
  //
  //   - In a TTY (the real human bootstrap case), mint a real approval
  //     record via the same code path `stele design approve` uses, then
  //     run `runDesignGenerate` with NO override. The approval record is
  //     attributable, lives in `contract/design/approvals/`, and survives
  //     re-running `stele design generate` later.
  //   - Outside a TTY (agent / CI), refuse with a clear message pointing
  //     at the propose-and-approve flow. CI that needs a bootstrap can
  //     set `STELE_APPROVED_BY=<service-account>` env var, which the
  //     downstream `runDesignApprove` honours.
  if (opts.generate) {
    if (opts.dryRun) {
      // Dry-run skips the approval flow — no file writes happen anyway.
      await runDesignGenerate({ dryRun: true }, projectDir);
      return;
    }
    const isHumanContext =
      process.stdin.isTTY === true ||
      (typeof process.env.STELE_APPROVED_BY === "string" &&
        process.env.STELE_APPROVED_BY.trim().length > 0);
    if (!isHumanContext) {
      process.stderr.write(
        "[design:init] --generate requires an interactive TTY or STELE_APPROVED_BY env var.\n" +
          "[design:init] Run it interactively, or set STELE_APPROVED_BY=<human-or-service-account-id> before invoking.\n" +
          "[design:init] Without one of these, the approval record gating stele design generate would be unattributable.\n",
      );
      // No human identity = contract failure (approval gate).
      process.exitCode = ExitCode.CONTRACT_FAIL;
      return;
    }
    // Mint the bootstrap approval first so generate sees it.
    await runDesignApprove(
      {
        reason: `stele design init --generate (preset: ${opts.preset ?? "unspecified"})`,
      },
      projectDir,
    );
    if (process.exitCode === 1) {
      // runDesignApprove already wrote a stderr explanation; do not generate.
      return;
    }
    await runDesignGenerate({ dryRun: opts.dryRun }, projectDir);
  }
}
