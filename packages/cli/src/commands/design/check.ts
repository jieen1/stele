import { loadProfile, profilePathExists } from "../../design-profile/load.js";
import { validateProfile } from "../../design-profile/validate.js";
import { verifyManifestIntegrity } from "../../design-generator/manifest.js";
import { validateOwnership, validateSourceOwnership } from "../../design-generator/ownership.js";
import { ExitCode } from "../../errors.js";

export type DesignCheckOptions = {
  profileOnly?: boolean;
  json?: boolean;
};

export interface DesignCheckResult {
  status: "pass" | "fail";
  profileValid: boolean;
  manifestValid: boolean;
  ownershipValid: boolean;
  sourceOwnershipValid: boolean;
  errors: string[];
  warnings: string[];
}

export async function runDesignCheck(opts: DesignCheckOptions, projectDir: string = process.cwd()): Promise<void> {
  const result = await checkDesign(projectDir, opts);
  const out = opts.json ? JSON.stringify(result, null, 2) : formatDesignCheck(result);
  process.stdout.write(out + "\n");

  if (result.status === "fail") {
    process.exitCode = ExitCode.CONTRACT_FAIL;
  }
}

export async function checkDesign(projectDir: string, opts: DesignCheckOptions): Promise<DesignCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Check profile exists
  if (!profilePathExists(projectDir)) {
    errors.push("Design profile not found at contract/design/profile.yaml");
    return {
      status: "fail",
      profileValid: false,
      manifestValid: false,
      ownershipValid: false,
      sourceOwnershipValid: false,
      errors,
      warnings,
    };
  }

  // 2. Validate profile schema
  let profileValid = true;
  let profile: Awaited<ReturnType<typeof loadProfile>> | null = null;
  try {
    profile = await loadProfile(projectDir);
    const validationErrors = validateProfile(profile);
    if (validationErrors.length > 0) {
      profileValid = false;
      for (const err of validationErrors) {
        errors.push(`[profile] ${err.field}: ${err.message}`);
      }
    }
  } catch (err) {
    profileValid = false;
    errors.push(`[profile] Failed to load profile: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Profile-only mode: run source ownership, skip manifest/generated ownership
  if (opts.profileOnly) {
    let sourceOwnershipValid = true;
    if (profileValid && profile) {
      const srcResult = runSourceOwnership(projectDir, profile);
      if (!srcResult.valid) {
        sourceOwnershipValid = false;
        if (srcResult.unowned.length > 0) {
          errors.push(`[source-ownership] ${srcResult.unowned.length} unowned file(s): ${srcResult.unowned.slice(0, 5).map((f) => f).join(", ")}${srcResult.unowned.length > 5 ? `, ...and ${srcResult.unowned.length - 5} more` : ""}`);
        }
        if (srcResult.ambiguous.length > 0) {
          errors.push(`[source-ownership] ${srcResult.ambiguous.length} ambiguous file(s): ${srcResult.ambiguous.slice(0, 5).map((f) => f).join(", ")}${srcResult.ambiguous.length > 5 ? `, ...and ${srcResult.ambiguous.length - 5} more` : ""}`);
        }
      }
    }
    return {
      status: (profileValid && sourceOwnershipValid) ? "pass" : "fail",
      profileValid,
      manifestValid: true,
      ownershipValid: true,
      sourceOwnershipValid,
      errors,
      warnings,
    };
  }

  // 4. Verify manifest integrity
  let manifestValid = true;
  const manifestResult = verifyManifestIntegrity(projectDir);
  if (!manifestResult.valid) {
    manifestValid = false;
    for (const drift of manifestResult.drifts) {
      errors.push(`[manifest] Drift detected: ${drift}`);
    }
  }

  // 5. Validate ownership
  let ownershipValid = true;
  const ownershipResult = validateOwnership(projectDir);
  if (!ownershipResult.owned) {
    ownershipValid = false;
    if (ownershipResult.orphanCount > 0) {
      errors.push(`[ownership] ${ownershipResult.orphanCount} orphan file(s) in contract/generated/`);
    }
    if (ownershipResult.missingCount > 0) {
      errors.push(`[ownership] ${ownershipResult.missingCount} file(s) missing from contract/generated/`);
    }
    for (const edit of ownershipResult.unexpectedEdits) {
      errors.push(`[ownership] Unexpected edit: ${edit}`);
    }
  }

  // 6. Validate source-root ownership
  let sourceOwnershipValid = true;
  if (profileValid && profile) {
    const srcResult = runSourceOwnership(projectDir, profile);
    if (!srcResult.valid) {
      sourceOwnershipValid = false;
      if (srcResult.unowned.length > 0) {
        errors.push(`[source-ownership] ${srcResult.unowned.length} unowned file(s): ${srcResult.unowned.slice(0, 5).map((f) => f).join(", ")}${srcResult.unowned.length > 5 ? `, ...and ${srcResult.unowned.length - 5} more` : ""}`);
      }
      if (srcResult.ambiguous.length > 0) {
        errors.push(`[source-ownership] ${srcResult.ambiguous.length} ambiguous file(s): ${srcResult.ambiguous.slice(0, 5).map((f) => f).join(", ")}${srcResult.ambiguous.length > 5 ? `, ...and ${srcResult.ambiguous.length - 5} more` : ""}`);
      }
    }
  }

  return {
    status: (profileValid && manifestValid && ownershipValid && sourceOwnershipValid) ? "pass" : "fail",
    profileValid,
    manifestValid,
    ownershipValid,
    sourceOwnershipValid,
    errors,
    warnings,
  };
}

function formatDesignCheck(result: DesignCheckResult): string {
  const lines: string[] = [];

  lines.push(`Design check: ${result.status === "pass" ? "PASS" : "FAIL"}`);
  lines.push(`  Profile: ${result.profileValid ? "valid" : "INVALID"}`);
  lines.push(`  Manifest: ${result.manifestValid ? "valid" : "INVALID"}`);
  lines.push(`  Ownership: ${result.ownershipValid ? "valid" : "INVALID"}`);
  lines.push(`  Source Ownership: ${result.sourceOwnershipValid ? "valid" : "INVALID"}`);

  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const err of result.errors) {
      lines.push(`  - ${err}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warn of result.warnings) {
      lines.push(`  - ${warn}`);
    }
  }

  return lines.join("\n");
}

/**
 * Extract parameters from a design profile and call validateSourceOwnership.
 */
function runSourceOwnership(
  projectDir: string,
  profile: Awaited<ReturnType<typeof loadProfile>>,
): ReturnType<typeof validateSourceOwnership> {
  const contextRoots = profile.ddd?.contexts
    ?.map((ctx) => ctx.root)
    .filter((root): root is string => typeof root === "string") ?? [];

  const sharedKernels = profile.ddd?.shared_kernels
    ?.flatMap((sk) => sk.paths)
    .filter((p): p is string => typeof p === "string") ?? [];

  const ignorePatterns = profile.project?.ignore ?? [];

  return validateSourceOwnership(
    projectDir,
    profile.project?.source_roots ?? [],
    contextRoots,
    sharedKernels,
    ignorePatterns,
  );
}
