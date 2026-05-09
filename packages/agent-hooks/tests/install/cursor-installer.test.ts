import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_MARKER,
  install,
  renderRulesMarkdown,
  uninstall,
} from "../../src/install/cursor-installer.js";
import { DEFAULT_CONFIG } from "@stele/cli";

const tempDirs: string[] = [];

async function createProject(): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "stele-cursor-installer-"));
  tempDirs.push(projectDir);
  const configPath = join(projectDir, "stele.config.json");
  await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG), "utf8");
  await mkdir(join(projectDir, "contract"), { recursive: true });
  await writeFile(
    join(projectDir, "contract", "main.stele"),
    [
      "(invariant SAMPLE_RULE",
      '  (severity high)',
      '  (description "demo invariant")',
      "  (assert (eq 1 1)))",
    ].join("\n"),
    "utf8",
  );
  return projectDir;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("cursor-installer", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates .cursor/rules/stele.md with the AUTO_MARKER on first line", async () => {
    const project = await createProject();
    const writeMock = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await install(project);

    const rules = await readFile(join(project, ".cursor", "rules", "stele.md"), "utf8");
    expect(rules.split("\n")[0]).toBe(AUTO_MARKER);
    expect(rules).toContain("# Stele Contract Rules (auto-generated)");
    expect(rules).toContain("- `contract/**/*.stele`");
    expect(rules).toContain("SAMPLE_RULE");
    expect(rules).not.toContain("rationale");
    expect(writeMock).toHaveBeenCalled();
  });

  it("does not create the composer hook by default", async () => {
    const project = await createProject();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await install(project);

    expect(await pathExists(join(project, ".cursor", "composer", "stele-check.sh"))).toBe(false);
  });

  it("creates the composer hook when enableShell is true", async () => {
    const project = await createProject();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await install(project, { enableShell: true });

    const composerPath = join(project, ".cursor", "composer", "stele-check.sh");
    expect(await pathExists(composerPath)).toBe(true);
    const script = await readFile(composerPath, "utf8");
    expect(script).toContain("#!/usr/bin/env bash");
    expect(script).toContain("stele check --json");
  });

  it("re-installing over an auto-generated file succeeds without --force", async () => {
    const project = await createProject();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await install(project);
    await install(project); // should not throw because AUTO_MARKER is still present

    const rules = await readFile(join(project, ".cursor", "rules", "stele.md"), "utf8");
    expect(rules.startsWith(AUTO_MARKER)).toBe(true);
  });

  it("refuses to overwrite a hand-edited rules file without --force", async () => {
    const project = await createProject();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const rulesFile = join(project, ".cursor", "rules", "stele.md");
    await mkdir(dirname(rulesFile), { recursive: true });
    await writeFile(rulesFile, "# Custom rules\nLeave me alone.\n", "utf8");

    await expect(install(project)).rejects.toThrow(/E_CURSOR_RULES_OVERWRITE|exists and was not auto-generated/u);

    const preserved = await readFile(rulesFile, "utf8");
    expect(preserved).toContain("Leave me alone");
  });

  it("overwrites a hand-edited rules file with --force", async () => {
    const project = await createProject();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const rulesFile = join(project, ".cursor", "rules", "stele.md");
    await mkdir(dirname(rulesFile), { recursive: true });
    await writeFile(rulesFile, "# Custom rules\n", "utf8");

    await install(project, { force: true });

    const rules = await readFile(rulesFile, "utf8");
    expect(rules.startsWith(AUTO_MARKER)).toBe(true);
    expect(rules).not.toContain("# Custom rules\n#");
  });

  it("uninstall removes the rules file and composer hook idempotently", async () => {
    const project = await createProject();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await install(project, { enableShell: true });
    await uninstall(project);

    expect(await pathExists(join(project, ".cursor", "rules", "stele.md"))).toBe(false);
    expect(await pathExists(join(project, ".cursor", "composer", "stele-check.sh"))).toBe(false);

    // Idempotent: second uninstall does not throw.
    await uninstall(project);
  });

  it("renders an empty-invariant section when contract is missing", async () => {
    const project = await mkdtemp(join(tmpdir(), "stele-cursor-installer-noctr-"));
    tempDirs.push(project);
    await writeFile(join(project, "stele.config.json"), JSON.stringify(DEFAULT_CONFIG), "utf8");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await install(project);

    const rules = await readFile(join(project, ".cursor", "rules", "stele.md"), "utf8");
    expect(rules).toContain("_(none currently defined)_");
  });

  it("renderRulesMarkdown does not include the rationale field", () => {
    const rendered = renderRulesMarkdown(DEFAULT_CONFIG, {
      invariants: [
        { id: "RULE_A", severity: "high", description: "Demo description" },
      ],
    });
    expect(rendered).toContain("RULE_A");
    expect(rendered).not.toMatch(/rationale/iu);
  });

  it("renderRulesMarkdown caps invariants at 30 with overflow note", () => {
    const invariants = Array.from({ length: 35 }, (_, i) => ({
      id: `RULE_${i}`,
      severity: "low",
      description: `desc ${i}`,
    }));
    const rendered = renderRulesMarkdown(DEFAULT_CONFIG, { invariants });
    expect(rendered).toContain("RULE_0");
    expect(rendered).toContain("RULE_29");
    expect(rendered).not.toContain("RULE_30");
    expect(rendered).toContain("(+ 5 more)");
  });
});
