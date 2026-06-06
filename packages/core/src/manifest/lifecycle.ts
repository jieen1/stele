/**
 * Phase 5.1 self-dogfooding — MANIFEST_LIFECYCLE phantom types.
 *
 * The `ContractManifest` runtime shape is identical regardless of lifecycle
 * position; what changes is the legal operation set on it. We encode the
 * lifecycle position as a phantom type parameter and pair it with a
 * state-keyed `StateBrand<S>` so `Manifest<"Loaded">` and `Manifest<"Locked">`
 * are NOT structurally compatible (per reviewer V-05).
 *
 * Compile-time enforcement: passing `Manifest<"Loaded">` where
 * `Manifest<"Locked">` is required fails with a tsc error because
 * `__state_Locked` would have to be `true` but is `never` on a `Loaded`
 * value.
 *
 * Enforcement is at COMPILE TIME: `writeLockedManifest` accepts only a
 * `Manifest<"Locked">`, so the production call-sites in `lock`, `baseline`,
 * and `check-stages-protected` cannot persist a manifest without routing it
 * through `buildLoadedManifestForPaths → lockManifest → writeLockedManifest`.
 * tsc rejects any skipped step; see `manifest-lifecycle.test-d.ts`.
 */

import type { ContractManifest, VerificationResult } from "./manifest.js";
import {
  buildContractManifest,
  verifyManifest,
  writeContractManifestObject,
} from "./manifest.js";

export type ManifestState = "Unloaded" | "Loaded" | "Locked" | "Verified";

/**
 * State-keyed brand: a `Manifest<"Loaded">` value carries
 * `__state_Loaded: true` and `__state_{Unloaded,Locked,Verified}: never`.
 * Assigning to another state's parameter triggers a tsc error.
 */
export type ManifestStateBrand<S extends ManifestState> = {
  readonly [K in ManifestState as `__state_${K}`]: K extends S ? true : never;
};

export type Manifest<S extends ManifestState = "Loaded"> = ContractManifest &
  ManifestStateBrand<S>;

/**
 * Tag a freshly-loaded `ContractManifest` with the `Loaded` phantom state.
 * The cast is unsafe at runtime (no field is actually added); the brand
 * lives exclusively at the type level.
 */
export function asLoaded(value: ContractManifest): Manifest<"Loaded"> {
  return value as Manifest<"Loaded">;
}

/**
 * Lock a `Loaded` manifest. The runtime is a no-op — the lifecycle state
 * is encoded in the phantom brand only — but the signature forces callers
 * to thread the state explicitly.
 */
export function lockManifest(m: Manifest<"Loaded">): Manifest<"Locked"> {
  return m as unknown as Manifest<"Locked">;
}

/**
 * Mark a `Locked` manifest as `Verified` after `verifyManifest` runs.
 */
export function verifyLockedManifest(m: Manifest<"Locked">): Manifest<"Verified"> {
  return m as unknown as Manifest<"Verified">;
}

/**
 * Closeout 4 (self-dogfooding plan): construct an in-memory `ContractManifest`
 * from the input paths + contract hash, brand it `Loaded`. This is the
 * only sanctioned entry point that turns "stele lock"-style inputs
 * (a path list and a contract hash) into a typed manifest value the
 * lifecycle pipeline can act on.
 *
 * The runtime payload returned here is identical to what `writeManifest`
 * would write to disk: per-path sha256 + size, the contract hash, the
 * Stele version, and a deterministic `generated_at` stamp (callers that
 * persist this manifest will write the same bytes regardless of when
 * `buildLoadedManifestForPaths` returned).
 *
 * @stele:effects fs.read, crypto.hash
 */
export async function buildLoadedManifestForPaths(
  paths: readonly string[],
  manifestPath: string,
  contractHash: string,
): Promise<Manifest<"Loaded">> {
  const value = await buildContractManifest(paths, manifestPath, contractHash);
  return value as Manifest<"Loaded">;
}

/**
 * Closeout 4: typed write entry for the contract manifest. Accepts only
 * a `Manifest<"Locked">` value so callers cannot persist a manifest
 * that has not gone through `buildLoadedManifestForPaths → lockManifest`.
 * Returns the value branded `Verified` so subsequent consumers know the
 * write has completed.
 *
 * @stele:effects fs.write
 */
export async function writeLockedManifest(
  locked: Manifest<"Locked">,
  manifestPath: string,
): Promise<Manifest<"Verified">> {
  await writeContractManifestObject(locked, manifestPath);
  return locked as unknown as Manifest<"Verified">;
}

/**
 * Closeout 4: typed read+verify entry for the contract manifest. Returns
 * both the lifecycle-branded value (a `Manifest<"Verified">`) and the
 * underlying `VerificationResult` so callers that need the per-file
 * diff (e.g. drift reporting) keep their existing access pattern.
 *
 * Internally delegates to `verifyManifest`. The returned `manifest`
 * field is a NON-DATA marker: it carries the `Manifest<"Verified">`
 * brand for type-level lifecycle continuity but holds NO manifest
 * payload. The verified on-disk content lives entirely in the
 * `verification` (`VerificationResult`) field; callers must read the
 * content from there. The marker exists only so the lifecycle's
 * Verified state has a typed witness at the read+verify site.
 *
 * @stele:effects fs.read, crypto.hash
 */
export async function verifyManifestToVerified(
  manifestPath: string,
): Promise<{ readonly manifest: Manifest<"Verified">; readonly verification: VerificationResult }> {
  const verification = await verifyManifest(manifestPath);
  return {
    // Non-data marker: brand only, no payload. Verified content is in `verification`.
    manifest: { __verified_marker: true } as unknown as Manifest<"Verified">,
    verification,
  };
}
