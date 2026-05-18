import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadContract, parseFile } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { readOptionalFile } from "../utils/shared-utils.js";
import { createEvent, writeEvent } from "../events/write-event.js";

const PROPOSAL_FILE = "contract/proposals/agent-additions.stele";
const PROPOSAL_IMPORT = '(import "./proposals/agent-additions.stele")';
const VALID_SEVERITIES = ["error", "warning", "info"] as const;

export type ProposeOptions = {
  kind: "invariant";
  id: string;
  severity: string;
  description: string;
  assert: string;
  category?: string;
  rationale?: string;
  apply?: boolean;
};

export async function runPropose(projectDir: string, options: ProposeOptions): Promise<void> {
  const proposal = await buildInvariantProposal(projectDir, options);

  if (!options.apply) {
    process.stdout.write(proposal);
    return;
  }

  await appendProposal(projectDir, proposal);
  await writeEvent(
    projectDir,
    createEvent("contract-evolution", projectDir, {
      invariant_id: options.id,
      action: "proposed",
    }),
  );
  process.stdout.write(`OK proposed invariant ${options.id} in ${PROPOSAL_FILE}. Run stele generate --force, pytest, and stele lock only after user review.\n`);
}

async function buildInvariantProposal(projectDir: string, options: ProposeOptions): Promise<string> {
  validateInvariantOptions(options);

  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));

  if (contract.invariants.some((invariant) => invariant.id === options.id) || (await proposalTextContainsId(projectDir, options.id))) {
    throw new Error(`Invariant "${options.id}" already exists. Stele propose is add-only and will not modify existing rules.`);
  }

  const lines = [
    `(invariant ${options.id}`,
    `  (severity ${options.severity})`,
    `  (description ${JSON.stringify(options.description)})`,
    ...(options.category === undefined ? [] : [`  (category ${formatCdlValue(options.category)})`]),
    ...(options.rationale === undefined ? [] : [`  (rationale ${JSON.stringify(options.rationale)})`]),
    `  (assert ${options.assert}))`,
    "",
  ];
  const proposal = lines.join("\n");

  parseFile(proposal, PROPOSAL_FILE);
  return proposal;
}

async function appendProposal(projectDir: string, proposal: string): Promise<void> {
  const config = await loadConfig(projectDir);
  const mainPath = resolve(projectDir, config.entry);
  const proposalPath = resolve(projectDir, PROPOSAL_FILE);
  const originalMain = await readFile(mainPath, "utf8");
  const originalProposal = await readOptionalFile(proposalPath);
  const nextMain = originalMain.includes(PROPOSAL_IMPORT) ? originalMain : `${PROPOSAL_IMPORT}\n${originalMain}`;
  const nextProposal = `${originalProposal ?? ""}${originalProposal === undefined || originalProposal.endsWith("\n") ? "" : "\n"}${proposal}`;

  await mkdir(dirname(proposalPath), { recursive: true });

  try {
    await writeFile(mainPath, nextMain, "utf8");
    await writeFile(proposalPath, nextProposal, "utf8");
    await loadContract(resolve(projectDir, config.entry));
  } catch (error) {
    await writeFile(mainPath, originalMain, "utf8");
    if (originalProposal === undefined) {
      await rm(proposalPath, { force: true });
    } else {
      await writeFile(proposalPath, originalProposal, "utf8");
    }
    throw error;
  }
}

function validateInvariantOptions(options: ProposeOptions): void {
  if (options.kind !== "invariant") {
    throw new Error("Stele propose currently supports only invariant additions.");
  }

  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(options.id)) {
    throw new Error(`Invalid invariant id "${options.id}".`);
  }

  if (!VALID_SEVERITIES.includes(options.severity as (typeof VALID_SEVERITIES)[number])) {
    throw new Error(`Invalid severity "${options.severity}". Must be one of: ${VALID_SEVERITIES.join(", ")}.`);
  }

  if (options.description.trim().length === 0) {
    throw new Error("Invariant proposals require a non-empty description.");
  }

  if (options.assert.trim().length === 0) {
    throw new Error("Invariant proposals require a non-empty assert expression.");
  }
}

function formatCdlValue(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

async function proposalTextContainsId(projectDir: string, id: string): Promise<boolean> {
  const text = await readOptionalFile(resolve(projectDir, PROPOSAL_FILE));
  return text?.includes(`(invariant ${id}`) ?? false;
}

