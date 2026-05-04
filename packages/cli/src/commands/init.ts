import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, STELE_CONFIG_FILE } from "../config/defaults.js";

export type InitOptions = {
  language: string;
};

const DEFAULT_CONTRACT_SOURCE = [
  "(invariant EXAMPLE_RULE",
  "  (severity high)",
  '  (description "Replace this example rule with your first contract invariant.")',
  "  (assert (eq 1 1)))",
  "",
].join("\n");

const DEFAULT_CONFTEST_SOURCE = "import pytest\n\n@pytest.fixture\ndef stele_context():\n    return {}\n";

export async function runInit(projectDir: string, options: InitOptions): Promise<void> {
  const config = {
    ...DEFAULT_CONFIG,
    targetLanguage: options.language,
  };

  await writeIfMissing(join(projectDir, STELE_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  await writeIfMissing(join(projectDir, "contract", "main.stele"), DEFAULT_CONTRACT_SOURCE);
  await writeIfMissing(join(projectDir, "contract", "checker_impls", ".gitkeep"), "");
  await writeIfMissing(join(projectDir, "tests", "contract", "conftest.py"), DEFAULT_CONFTEST_SOURCE);
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path, "utf8");
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}
