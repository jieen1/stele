import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/loadConfig.js";

const CHECKER_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHECKER_STUB = `def check(inputs: dict) -> dict:
    return {
        "passed": False,
        "message": "Checker implementation has not been approved yet.",
        "context": inputs,
    }
`;

export async function runAddChecker(projectDir: string, checkerId: string): Promise<void> {
  if (!CHECKER_ID_PATTERN.test(checkerId)) {
    throw new Error(
      `Invalid checker id "${checkerId}". Checker ids must match ${CHECKER_ID_PATTERN} so they stay valid CDL identifiers and Python filenames.`,
    );
  }

  const config = await loadConfig(projectDir);
  const checkerPath = resolve(projectDir, config.checkerImplDir, `${checkerId}.py`);

  await mkdir(dirname(checkerPath), { recursive: true });

  try {
    await writeFile(checkerPath, CHECKER_STUB, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Checker implementation "${checkerId}" already exists at ${checkerPath}.`);
    }

    throw error;
  }

  process.stdout.write(`(checker ${checkerId}\n  (description "TODO: describe what this checker validates."))\n`);
}
