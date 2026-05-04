import { resolve } from "node:path";
import { loadContract, normalizeContract, writeManifest } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import {
  assertProtectedContractFilesReachable,
  collectProtectedPaths,
  createLanguageBackend,
  sha256,
  verifyManagedGeneratedFiles,
} from "./generate.js";

export type LockOptions = {
  reason?: string;
};

export async function runLock(projectDir: string, _options: LockOptions): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const backend = createLanguageBackend(config.generatedDir, config.targetLanguage, config.testFramework);
  const generated = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  if (!generated.ok) {
    throw new Error("Cannot refresh the manifest while generated files are out of date.");
  }

  const protectedPaths = await collectProtectedPaths(projectDir, config);
  await assertProtectedContractFilesReachable(projectDir, config.entry, protectedPaths, contract);

  await writeManifest(protectedPaths, resolve(projectDir, config.manifestPath), sha256(normalizeContract(contract)));
}
