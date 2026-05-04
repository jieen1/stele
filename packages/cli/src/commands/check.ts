import { resolve } from "node:path";
import { verifyManifest } from "@stele/core";
import { loadConfig } from "../config/loadConfig.js";
import { CliCommandError } from "../errors.js";
import {
  assertProtectedContractFilesReachable,
  collectProtectedPaths,
  createLanguageBackend,
  sha256,
  toManifestPaths,
  verifyManagedGeneratedFiles,
} from "./generate.js";
import { loadContract, normalizeContract } from "@stele/core";

export async function runCheck(projectDir: string): Promise<void> {
  const config = await loadConfig(projectDir);
  const contract = await loadContract(resolve(projectDir, config.entry));
  const backend = createLanguageBackend(config.generatedDir, config.targetLanguage, config.testFramework);
  const generated = await verifyManagedGeneratedFiles(projectDir, config.generatedDir, contract, backend);

  if (!generated.ok) {
    throw new CliCommandError(
      `Generated files do not match the contract. Missing: ${generated.missing.join(", ") || "<none>"}. Changed: ${generated.changed.join(", ") || "<none>"}. Extra: ${generated.extra.join(", ") || "<none>"}.`,
      2,
    );
  }

  try {
    const protectedPaths = await collectProtectedPaths(projectDir, config);
    await assertProtectedContractFilesReachable(projectDir, config.entry, protectedPaths, contract);

    const manifest = await verifyManifest(resolve(projectDir, config.manifestPath));
    const currentProtectedPaths = toManifestPaths(projectDir, protectedPaths);
    const manifestProtectedPathSet = new Set(manifest.files.map((file) => file.path));
    const newProtectedPaths = currentProtectedPaths.filter((path) => !manifestProtectedPathSet.has(path));

    if (!manifest.ok || newProtectedPaths.length > 0) {
      const messages: string[] = [];

      if (!manifest.ok) {
        messages.push(
          `Manifest verification failed. Missing: ${manifest.missing.join(", ") || "<none>"}. Changed: ${manifest.changed.join(", ") || "<none>"}.`,
        );
      }

      if (newProtectedPaths.length > 0) {
        messages.push(`Found new/unlocked protected files. Run stele lock after approval. Files: ${newProtectedPaths.join(", ")}.`);
      }

      throw new CliCommandError(messages.join(" "), 3);
    }

    const contractHash = sha256(normalizeContract(contract));

    if (manifest.contractHash !== contractHash) {
      throw new CliCommandError("Manifest contract hash does not match the current contract.", 3);
    }
  } catch (error) {
    if (error instanceof CliCommandError) {
      throw error;
    }

    throw new CliCommandError(error instanceof Error ? error.message : String(error), 3, error);
  }
}
