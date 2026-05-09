import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const STELE_HOOK_IDS = ["stele-generate", "stele-check"] as const;

type SteleHookId = (typeof STELE_HOOK_IDS)[number];

interface PreCommitHook {
  id: string;
  name?: string;
  entry?: string;
  language?: string;
  pass_filenames?: boolean;
  stages?: string[];
  files?: string;
  [key: string]: unknown;
}

interface PreCommitRepo {
  repo: string;
  hooks?: PreCommitHook[];
  rev?: string;
  [key: string]: unknown;
}

interface PreCommitConfig {
  repos?: PreCommitRepo[];
  [key: string]: unknown;
}

const YAML_DUMP_OPTIONS: yaml.DumpOptions = { lineWidth: -1, noRefs: true };

const PRE_COMMIT_FILE = ".pre-commit-config.yaml";
const TEMPLATE_FILE = "pre-commit-config.yaml";

export async function maybeInstallPreCommit(projectRoot: string): Promise<void> {
  const configPath = join(projectRoot, PRE_COMMIT_FILE);
  const template = await loadTemplate();

  const existing = await readOptionalConfig(configPath);

  if (existing == null) {
    await fs.writeFile(configPath, yaml.dump(template, YAML_DUMP_OPTIONS), "utf-8");
    process.stdout.write(`[stele] Created ${PRE_COMMIT_FILE} with Stele hooks.\n`);
    return;
  }

  const templateLocalRepo = template.repos?.find((r) => r.repo === "local");
  if (templateLocalRepo == null || templateLocalRepo.hooks == null) {
    throw new Error(`Internal error: bundled ${TEMPLATE_FILE} is missing the "repo: local" block.`);
  }

  existing.repos = existing.repos ?? [];
  const localRepo = existing.repos.find((r) => r.repo === "local");

  if (localRepo == null) {
    existing.repos.push(cloneRepo(templateLocalRepo));
    await fs.writeFile(configPath, yaml.dump(existing, YAML_DUMP_OPTIONS), "utf-8");
    process.stdout.write(`[stele] Appended Stele local hooks block to existing ${PRE_COMMIT_FILE}.\n`);
    return;
  }

  localRepo.hooks = localRepo.hooks ?? [];
  const existingSteleIds = new Set(
    localRepo.hooks
      .map((h) => h.id)
      .filter((id): id is SteleHookId => isSteleHookId(id)),
  );

  if (existingSteleIds.size === STELE_HOOK_IDS.length) {
    process.stdout.write(`[stele] ${PRE_COMMIT_FILE} already has Stele hooks; skipping.\n`);
    return;
  }

  let added = 0;
  for (const hook of templateLocalRepo.hooks) {
    if (!isSteleHookId(hook.id)) continue;
    if (existingSteleIds.has(hook.id)) continue;
    localRepo.hooks.push(cloneHook(hook));
    added++;
  }

  if (added === 0) {
    process.stdout.write(`[stele] ${PRE_COMMIT_FILE} already has Stele hooks; skipping.\n`);
    return;
  }

  await fs.writeFile(configPath, yaml.dump(existing, YAML_DUMP_OPTIONS), "utf-8");
  process.stdout.write(`[stele] Added missing Stele hooks to existing ${PRE_COMMIT_FILE}.\n`);
}

async function loadTemplate(): Promise<PreCommitConfig> {
  const templatePath = await locateTemplate();
  const raw = await fs.readFile(templatePath, "utf-8");
  const parsed = yaml.load(raw);
  if (parsed == null || typeof parsed !== "object") {
    throw new Error(`Internal error: bundled ${TEMPLATE_FILE} is empty or not an object.`);
  }
  return parsed as PreCommitConfig;
}

async function locateTemplate(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Source layout: src/commands/pre-commit.ts -> ../../templates/...
    join(here, "..", "..", "templates", TEMPLATE_FILE),
    // Bundled layout: dist/index.js -> ./templates/...
    join(here, "templates", TEMPLATE_FILE),
    // Bundled layout fallback: dist/something.js -> ../templates/...
    join(here, "..", "templates", TEMPLATE_FILE),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error(`Internal error: cannot locate bundled ${TEMPLATE_FILE} (searched ${candidates.join(", ")}).`);
}

async function readOptionalConfig(configPath: string): Promise<PreCommitConfig | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const parsed = yaml.load(raw);
  if (parsed == null || typeof parsed !== "object") {
    return {};
  }

  return parsed as PreCommitConfig;
}

function isSteleHookId(value: unknown): value is SteleHookId {
  return typeof value === "string" && (STELE_HOOK_IDS as readonly string[]).includes(value);
}

function cloneHook(hook: PreCommitHook): PreCommitHook {
  return JSON.parse(JSON.stringify(hook)) as PreCommitHook;
}

function cloneRepo(repo: PreCommitRepo): PreCommitRepo {
  return JSON.parse(JSON.stringify(repo)) as PreCommitRepo;
}
