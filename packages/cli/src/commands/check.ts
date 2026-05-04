import { resolve } from "node:path";
import { verifyManifest } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { collectProtectedManifestPaths, createLanguageBackend, sha256, verifyManagedGeneratedFiles } from "./generate.js";
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
  const currentProtectedPaths = await collectProtectedManifestPaths(projectDir, {
    contractDir: config.contractDir,
    checkerImplDir: config.checkerImplDir,
    generatedDir: config.generatedDir,
  });
  const manifestProtectedPaths = manifest.files.map((file) => file.path);
  const newProtectedPaths = currentProtectedPaths.filter((path) => !manifestProtectedPaths.includes(path));

  if (!manifest.ok) {
    throw new Error(
      `Manifest verification failed. Missing: ${manifest.missing.join(", ") || "<none>"}. Changed: ${manifest.changed.join(", ") || "<none>"}.`,
    );
  }

  if (newProtectedPaths.length > 0) {
    throw new Error(`Found new/unlocked protected files. Run stele lock after approval. Files: ${newProtectedPaths.join(", ")}.`);
  }

  const contractHash = sha256(normalizeContract(contract));

  if (manifest.contractHash !== contractHash) {
    throw new Error("Manifest contract hash does not match the current contract.");
  }
}
