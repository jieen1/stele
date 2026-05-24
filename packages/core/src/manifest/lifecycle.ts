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
 * Evaluator enforcement: the contract's `(type-state MANIFEST_LIFECYCLE ...)`
 * declaration targets the `Manifest` symbol from this file. The TS extractor
 * (B.1) recognises class-method calls only; the present free-function
 * transition surface is documentation for the evaluator until the
 * call-sites in `lock`/`baseline`/`check-stages-protected` are routed
 * through the typed pipeline below.
 */

import type { ContractManifest } from "./manifest.js";

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
