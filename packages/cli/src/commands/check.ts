import { resolve } from "node:path";
import { verifyManifest } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { createLanguageBackend, sha256, verifyManagedGeneratedFiles } from "./generate.js";
import { loadContract, normalizeContract } from "@stele/core";

export async function runCheck(projectDir: string): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const backend = createLanguageBackend(config.generatedDir, config.targetLanguage, config.testFramework);
  const generated = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  if (!generated.ok) {
    throw new Error(
      `Generated files do not match the contract. Missing: ${generated.missing.join(", ") || "<none>"}. Changed: ${generated.changed.join(", ") || "<none>"}. Extra: ${generated.extra.join(", ") || "<none>"}.`,
    );
  }

  const manifest = await verifyManifest(resolve(projectDir, config.manifestPath));

  if (!manifest.ok) {
    throw new Error(
      `Manifest verification failed. Missing: ${manifest.missing.join(", ") || "<none>"}. Changed: ${manifest.changed.join(", ") || "<none>"}.`,
    );
  }

  const contractHash = sha256(normalizeContract(contract));

  if (manifest.contractHash !== contractHash) {
    throw new Error("Manifest contract hash does not match the current contract.");
  }
}
