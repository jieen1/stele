import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContract } from "@stele/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkProject } from "../src/commands/check.js";
import { runGenerate } from "../src/commands/generate.js";
import { runLock } from "../src/commands/lock.js";
import { readProvenance } from "../src/commands/incident/provenance.js";
import {
  runIncidentApprove,
  type IncidentApproveOptions,
} from "../src/commands/incident/approve.js";
import {
  writeCandidateTest,
  writeDraftJson,
  type IncidentDraft,
  type TeethProof,
} from "../src/commands/incident/shared.js";

const ORIGINAL_CWD = process.cwd();
const GOOD_APPROVER = "alice@example.com";

let tempDirs: string[] = [];
let priorApprovedBy: string | undefined;

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

/**
 * A minimal but FULLY GENERATED+LOCKED stele project: contract entry + config,
 * then generate→lock so a real manifest and generated tests exist for approve's
 * outer snapshot to capture and (on rollback) restore. checkProject is exit-0
 * here at baseline.
 */
async function makeLockedProject(): Promise<string> {
  const dir = track(mkdtempSync(join(tmpdir(), "stele-incident-approve-")));
  mkdirSync(join(dir, "contract"), { recursive: true });
  writeFileSync(
    join(dir, "contract", "main.stele"),
    '(invariant baseline_always\n  (severity info)\n  (description "Baseline invariant for the fixture")\n  (assert (eq 1 1)))\n',
    "utf8",
  );
  writeFileSync(
    join(dir, "stele.config.json"),
    JSON.stringify({ targetLanguage: "python", testFramework: "pytest" }, null, 2),
    "utf8",
  );
  await runGenerate(dir, { force: true });
  await runLock(dir, { reason: "baseline" });
  return dir;
}

async function seedDraft(
  dir: string,
  id: string,
  overrides: Partial<IncidentDraft> = {},
): Promise<IncidentDraft> {
  const draft: IncidentDraft = {
    intent: "incident under test",
    fixSha: "a".repeat(40),
    parentSha: "b".repeat(40),
    invariantCdl:
      '(invariant incident_rule\n  (severity error)\n  (description "from incident")\n  (assert (eq 1 1)))\n',
    negativeTest: "def test_x():\n    assert True\n",
    testFilename: `test_incident_${id}.py`,
    ...overrides,
  };
  await writeDraftJson(dir, id, draft);
  await writeCandidateTest(dir, id, draft);
  return draft;
}

/**
 * Seed a teeth proof that BINDS to the draft already written for `id`: parentSha
 * / fixSha mirror seedDraft's defaults and testSha256 is the real sha256 of the
 * candidate-test bytes on disk, so approve's binding gate (parentSha/fixSha/test
 * hash must equal the draft) accepts it. `overrides` lets a negative test corrupt
 * exactly one binding field to prove approve refuses a stale/swapped proof.
 */
function seedTeeth(
  dir: string,
  id: string,
  verdict: TeethProof["verdict"],
  overrides: Partial<TeethProof> = {},
): void {
  const draft = JSON.parse(
    readFileSync(join(dir, ".stele", "incident", id, "draft.json"), "utf8"),
  ) as IncidentDraft;
  const testBytes = readFileSync(join(dir, ".stele", "incident", id, draft.testFilename));
  const proof: TeethProof = {
    verdict,
    parentSha: draft.parentSha,
    fixSha: draft.fixSha,
    testSha256: createHash("sha256").update(testBytes).digest("hex"),
    invariantSha256: createHash("sha256").update(draft.invariantCdl).digest("hex"),
    parentBiteClass: verdict === "TEETH_PROVEN" ? "assertion" : "passed",
    parentRun: { exit: verdict === "TEETH_PROVEN" ? 1 : 0, outputSha256: "d".repeat(64) },
    fixRun: { exit: 0, outputSha256: "e".repeat(64) },
    producedAtFromGit: "2021-01-02T03:04:05+00:00",
    ...overrides,
  };
  const proofsDir = join(dir, ".stele", "proofs", id);
  mkdirSync(proofsDir, { recursive: true });
  writeFileSync(join(proofsDir, "teeth.json"), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
}

async function expectCheckClean(dir: string): Promise<void> {
  // checkProject resolves with {summary,report} on a clean repo and THROWS a
  // CheckCommandError on manifest/protected drift, so "clean" = no throw AND an
  // empty violations report. (CheckSummary has no exitCode/failed field.)
  const result = await checkProject(dir, {});
  expect(result.report.violations.length).toBe(0);
}

function snapshotMutationSet(dir: string): {
  entry: string;
  proposal: string | null;
  manifest: string | null;
  generated: Map<string, string>;
} {
  const proposalPath = join(dir, "contract", "proposals", "agent-additions.stele");
  const manifestPath = join(dir, "contract", ".manifest.json");
  const genDir = join(dir, "tests", "contract");
  const generated = new Map<string, string>();
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else generated.set(full, readFileSync(full, "utf8"));
    }
  };
  walk(genDir);
  return {
    entry: readFileSync(join(dir, "contract", "main.stele"), "utf8"),
    proposal: existsSync(proposalPath) ? readFileSync(proposalPath, "utf8") : null,
    manifest: existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null,
    generated,
  };
}

function numericExit(err: unknown): number {
  if (typeof err === "object" && err !== null && "exitCode" in err) {
    const code = (err as { exitCode?: unknown }).exitCode;
    if (typeof code === "number") return code;
  }
  return 1; // index.ts maps plain errors via getExitCode(error) ?? 1.
}

// The harness injects STELE_APPROVED_BY into process.env and a `delete`/reassign
// does not reliably stick in this worker, so the real identity gate is
// non-deterministic here. We inject the gate via deps (the same DI seam used for
// propose/generate/lock) so identity outcomes are deterministic and
// env-independent. Production still defaults to the real design-approve gate.
const ACCEPT_GATE = (): { ok: true; approvedBy: string } => ({
  ok: true,
  approvedBy: GOOD_APPROVER,
});
const REJECT_GATE = (): { ok: false; reason: string } => ({
  ok: false,
  reason: "denylisted approver token",
});

async function approve(
  dir: string,
  opts: IncidentApproveOptions,
  extraDeps: Parameters<typeof runIncidentApprove>[2] = {},
): Promise<unknown> {
  return runIncidentApprove(dir, opts, { resolveApprovedBy: ACCEPT_GATE, ...extraDeps }).then(
    () => undefined,
    (e) => e,
  );
}

beforeEach(() => {
  tempDirs = [];
  priorApprovedBy = process.env.STELE_APPROVED_BY;
  delete process.env.STELE_APPROVED_BY;
  process.exitCode = 0;
});

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  if (priorApprovedBy === undefined) delete process.env.STELE_APPROVED_BY;
  else process.env.STELE_APPROVED_BY = priorApprovedBy;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
});

describe("runIncidentApprove — teeth gate", () => {
  it("refuse-without-teeth: no proof + no reason → exit 1, no mutation", async () => {
    const dir = await makeLockedProject();
    const id = "no-teeth";
    await seedDraft(dir, id);
    const before = snapshotMutationSet(dir);

    const err = (await approve(dir, { id, approvedBy: GOOD_APPROVER })) as { exitCode?: number };
    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal);
    expect(after.manifest).toBe(before.manifest);
  });

  it("refuse-on-TEETH_FAILED: even WITH --teeth-unavailable-reason → exit 1", async () => {
    const dir = await makeLockedProject();
    const id = "failed-teeth";
    await seedDraft(dir, id);
    seedTeeth(dir, id, "TEETH_FAILED");
    const before = snapshotMutationSet(dir);

    const err = (await approve(dir, {
      id,
      approvedBy: GOOD_APPROVER,
      teethUnavailableReason: "I really want this",
    })) as { exitCode?: number };
    expect(err.exitCode).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal);
    expect(after.manifest).toBe(before.manifest);
  });

  it("refuse-on-swapped-test: TEETH_PROVEN but candidate-test bytes changed → exit 1, no mutation", async () => {
    const dir = await makeLockedProject();
    const id = "swapped-test";
    await seedDraft(dir, id);
    seedTeeth(dir, id, "TEETH_PROVEN");
    // Mutate the candidate test on disk AFTER the proof was written: its sha256
    // no longer matches teeth.testSha256, so the binding gate must refuse.
    writeFileSync(
      join(dir, ".stele", "incident", id, `test_incident_${id}.py`),
      "def test_x():\n    assert False  # weakened\n",
      "utf8",
    );
    const before = snapshotMutationSet(dir);

    const err = (await approve(dir, { id, approvedBy: GOOD_APPROVER })) as { exitCode?: number };
    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal);
    expect(after.manifest).toBe(before.manifest);
  });

  it("refuse-on-swapped-invariant: TEETH_PROVEN but invariantCdl weakened after proof → exit 1, no mutation", async () => {
    // B1: the prove-strict-then-lock-vacuous hole. Prove teeth on the original
    // invariant, then swap in a weaker invariant with byte-identical test/SHAs.
    // The invariant-hash binding must refuse — the proof attests to the test AND
    // the invariant it was produced for.
    const dir = await makeLockedProject();
    const id = "swapped-invariant";
    await seedDraft(dir, id);
    seedTeeth(dir, id, "TEETH_PROVEN");
    await seedDraft(dir, id, {
      invariantCdl:
        '(invariant incident_rule\n  (severity error)\n  (description "weakened")\n  (assert (eq 0 0)))\n',
    });
    const before = snapshotMutationSet(dir);

    const err = (await approve(dir, { id, approvedBy: GOOD_APPROVER })) as { exitCode?: number };
    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal);
    expect(after.manifest).toBe(before.manifest);
  });

  it("refuse-on-repointed-fixSha: TEETH_PROVEN but draft.fixSha repointed after proof → exit 1, no mutation", async () => {
    const dir = await makeLockedProject();
    const id = "repointed";
    await seedDraft(dir, id);
    seedTeeth(dir, id, "TEETH_PROVEN");
    // Re-seed the draft with a DIFFERENT fixSha after the proof exists. The proof
    // attests to the original fixSha; approve's binding gate must refuse.
    await seedDraft(dir, id, { fixSha: "f".repeat(40) });
    const before = snapshotMutationSet(dir);

    const err = (await approve(dir, { id, approvedBy: GOOD_APPROVER })) as { exitCode?: number };
    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal);
    expect(after.manifest).toBe(before.manifest);
  });
});

describe("runIncidentApprove — accept paths", () => {
  it("accept-on-TEETH_PROVEN: applies provenance-tagged invariant, repo stays check-0", async () => {
    const dir = await makeLockedProject();
    const id = "proven";
    const draft = await seedDraft(dir, id);
    seedTeeth(dir, id, "TEETH_PROVEN");

    const err = await approve(dir, { id, approvedBy: GOOD_APPROVER });
    expect(err).toBeUndefined();

    const proposal = readFileSync(
      join(dir, "contract", "proposals", "agent-additions.stele"),
      "utf8",
    );
    expect(proposal).toContain("incident_rule");
    expect(proposal).toContain('(tags "provenance:incident")');
    expect(proposal).toContain(`fix:${draft.fixSha}`);

    const contract = await loadContract(join(dir, "contract", "main.stele"));
    expect(contract.invariants.some((i) => i.id === "incident_rule")).toBe(true);

    const scratchDir = join(dir, ".stele", "incident", id);
    const approvals = readdirSync(scratchDir).filter((f) => f.startsWith("approval-"));
    expect(approvals.length).toBe(1);
    const record = JSON.parse(readFileSync(join(scratchDir, approvals[0]), "utf8"));
    expect(record.approved_by).toBe(GOOD_APPROVER);

    // B3: a COMMITTED provenance record is written and round-trips with the
    // proof's SHAs/verdict/biteClass (reverify depends on this artifact).
    expect(existsSync(join(dir, "contract", "provenance", `${id}.json`))).toBe(true);
    const prov = await readProvenance(dir, id);
    expect(prov.parentSha).toBe(draft.parentSha);
    expect(prov.fixSha).toBe(draft.fixSha);
    expect(prov.verdict).toBe("TEETH_PROVEN");
    expect(prov.parentBiteClass).toBe("assertion");
    expect(prov.invariantId).toBe("incident_rule");
    expect(prov.invariantSha256).toBe(createHash("sha256").update(draft.invariantCdl).digest("hex"));

    await expectCheckClean(dir);
  });

  it("teeth-unavailable: no proof + reason → teeth:unproven tag + recorded reason", async () => {
    const dir = await makeLockedProject();
    const id = "unavail";
    await seedDraft(dir, id);

    const err = await approve(dir, {
      id,
      approvedBy: GOOD_APPROVER,
      teethUnavailableReason: "sandbox offline",
    });
    expect(err).toBeUndefined();

    const proposal = readFileSync(
      join(dir, "contract", "proposals", "agent-additions.stele"),
      "utf8",
    );
    expect(proposal).toContain('(tags "provenance:incident" "teeth:unproven")');

    const scratchDir = join(dir, ".stele", "incident", id);
    const approvals = readdirSync(scratchDir).filter((f) => f.startsWith("approval-"));
    const record = JSON.parse(readFileSync(join(scratchDir, approvals[0]), "utf8"));
    expect(record.reason).toContain("sandbox offline");

    // B3: a teeth-UNAVAILABLE approval has no re-runnable proof → no provenance
    // record (reverify only re-derives genuinely-proven incidents).
    expect(existsSync(join(dir, "contract", "provenance", `${id}.json`))).toBe(false);

    await expectCheckClean(dir);
  });
});

describe("runIncidentApprove — rollback + refusals", () => {
  it("rollback-on-forced-failure: generate throws → tree restored to snapshot", async () => {
    const dir = await makeLockedProject();
    const id = "rollback";
    await seedDraft(dir, id);
    seedTeeth(dir, id, "TEETH_PROVEN");
    const before = snapshotMutationSet(dir);

    const boom = new Error("forced generate failure") as Error & { exitCode: number };
    boom.exitCode = 4;
    const err = (await approve(dir, { id, approvedBy: GOOD_APPROVER }, {
      runGenerate: async () => {
        throw boom;
      },
    })) as { exitCode?: number } | undefined;

    expect(err).toBeDefined();
    expect(err?.exitCode).toBe(4);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal); // incl. prior absence (null)
    expect(after.manifest).toBe(before.manifest);
    expect([...after.generated.keys()].sort()).toEqual([...before.generated.keys()].sort());

    await expectCheckClean(dir);
  });

  it("identity-gate refusal: rejecting gate → exit 1, no mutation", async () => {
    const dir = await makeLockedProject();
    const id = "ident";
    await seedDraft(dir, id);
    seedTeeth(dir, id, "TEETH_PROVEN");
    const before = snapshotMutationSet(dir);

    // Inject a rejecting gate. Production reuses design approve's
    // resolveApprovedBy identically; here we prove approve REFUSES when the gate
    // says no — deterministic regardless of ambient env.
    const err = (await approve(dir, { id, approvedBy: "agent" }, {
      resolveApprovedBy: REJECT_GATE,
    })) as { exitCode?: number };
    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.proposal).toBe(before.proposal);
    expect(after.manifest).toBe(before.manifest);
  });

  it("duplicate-id refusal: invariant id already present → exit 1, tree clean", async () => {
    const dir = await makeLockedProject();
    const id = "dup";
    await seedDraft(dir, id, {
      invariantCdl:
        '(invariant baseline_always\n  (severity error)\n  (description "dup")\n  (assert (eq 1 1)))\n',
    });
    seedTeeth(dir, id, "TEETH_PROVEN");
    const before = snapshotMutationSet(dir);

    const err = await approve(dir, { id, approvedBy: GOOD_APPROVER });
    expect(err).toBeDefined();
    expect(numericExit(err)).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal);
    expect(after.manifest).toBe(before.manifest);
    await expectCheckClean(dir);
  });

  it("id path-safety: '../escape' rejected before any IO → exit 1", async () => {
    const dir = await makeLockedProject();
    const before = snapshotMutationSet(dir);

    const err = (await approve(dir, { id: "../escape", approvedBy: GOOD_APPROVER })) as {
      exitCode?: number;
    };
    expect(err.exitCode).toBe(1);

    const after = snapshotMutationSet(dir);
    expect(after.entry).toBe(before.entry);
    expect(after.proposal).toBe(before.proposal);
  });
});
