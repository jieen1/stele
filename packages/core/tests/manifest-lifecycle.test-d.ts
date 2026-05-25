/**
 * Phase 5.1 type-state self-protection — compile-time test for
 * `MANIFEST_LIFECYCLE` phantom-state discipline.
 *
 * This file is consumed by `tsc --noEmit` during the normal core
 * typecheck. The `@ts-expect-error` comments mark sites that MUST
 * surface a compile-time error; if any of them stop firing, the brand
 * design has regressed (reviewer V-05) and Phase 5.1 enforcement is
 * broken at the type layer.
 *
 * To verify a stuck `@ts-expect-error`, run:
 *   pnpm --filter @stele/core typecheck
 * and confirm zero errors. To prove the brand actually catches
 * misuses, comment out one `@ts-expect-error` line and re-run; tsc
 * must then report a `TS2345` (argument-not-assignable) error.
 */

import type { ContractManifest } from "../src/manifest/manifest.js";
import {
  asLoaded,
  lockManifest,
  verifyLockedManifest,
  writeLockedManifest,
  type Manifest,
} from "../src/manifest/lifecycle.js";

// A fake ContractManifest instance shared by the assertions below.
const sample: ContractManifest = {
  version: "1",
  generated_at: "1970-01-01T00:00:00Z",
  stele_version: "0.1.0",
  protected_files: {},
  contract_hash: "0".repeat(64),
};

// 1. Happy path: the typed pipeline accepts each transition exactly once.
const loaded: Manifest<"Loaded"> = asLoaded(sample);
const locked: Manifest<"Locked"> = lockManifest(loaded);
const verified: Manifest<"Verified"> = verifyLockedManifest(locked);
void verified;

// 2. Passing a `Loaded` manifest to `verifyLockedManifest` MUST fail —
//    the brand requires `__state_Locked: true` but `Loaded` carries
//    `__state_Locked: never`.
// @ts-expect-error — Loaded cannot be passed where Locked is required
verifyLockedManifest(loaded);

// 3. Passing a `Verified` manifest to `lockManifest` MUST fail — the
//    brand for `Locked` insists on `__state_Loaded: true` which is
//    `never` on a `Verified` value.
// @ts-expect-error — Verified cannot be passed where Loaded is required
lockManifest(verified);

// 4. Round-tripping through a raw ContractManifest erases the brand. A
//    direct assignment of an unbranded `ContractManifest` to
//    `Manifest<"Loaded">` MUST fail; the only way to obtain a branded
//    value is via `asLoaded()` (the smart constructor).
// @ts-expect-error — ContractManifest is not assignable to Manifest<"Loaded">
const smuggled: Manifest<"Loaded"> = sample;
void smuggled;

// 5. Closeout 4: `writeLockedManifest` accepts only `Manifest<"Locked">`.
//    Passing a `Loaded` brand MUST fail — the typed write entry is the
//    runtime gate that the MANIFEST_LIFECYCLE persist step happens via
//    `lockManifest` first. Mutating a production caller to drop
//    `lockManifest(loaded)` and feed the Loaded value directly into
//    `writeLockedManifest` trips THIS assertion.
// @ts-expect-error — Loaded cannot be passed where writeLockedManifest requires Locked
void writeLockedManifest(loaded, "contract/.manifest.json");
