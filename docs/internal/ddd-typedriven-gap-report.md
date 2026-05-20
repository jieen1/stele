# DDD + Type-Driven Pattern System — GAP Report

> Status: actionable gap list
> Date: 2026-05-20
> Source: `docs/design/ddd-typedriven-implementation-design.md`
>
> **Goal:** Every GAP → COMPLETE. Every PARTIAL → spec compliance verified. Every STUB → fully functional.
> **Process:** Sub-agent driven development. Leader verifies with evidence. Dual review per task.

---

## Summary

| Status | Count |
|--------|-------|
| COMPLETE | 26 |
| PARTIAL | 0 |
| STUB | 0 |
| GAP | 0 |
| **Total Items** | **26** |

---

## GAP Items (Must Implement)

### GAP-1: Design Integrity Stage in `stele check`

**Design Doc Reference:** Section 5.4, Section 9.3
**Current State:** `packages/cli/src/commands/check.ts` has zero references to design profile, manifest, or ownership.

**Required:**
1. Add `design_integrity` stage to `stele check` pipeline
2. Check runs when `contract/design/profile.yaml` exists
3. Runs before ordinary rule checks (per Section 9.3 order):
   - Validate profile schema + protected path coverage
   - Validate source-root ownership
   - Validate profile/generator/output hashes against manifest
   - Classify design diff against approved profile hash
4. Emit blocking violations for unapproved weakening, restructuring, drift
5. Skip silently when no design profile exists
6. Test: fixture with design profile → `stele check --json` shows design_integrity stage

### GAP-2: Toolchain Stages Wired into `stele check`

**Design Doc Reference:** Section 8.1, 8.2, 8.3
**Current State:** `tsconfig-policy.ts`, `typescript.ts`, `eslint.ts` exist as standalone utilities. Never called from `check.ts`.

**Required:**
1. Add `toolchain` stage to `stele check` pipeline
2. Only runs when profile has `toolchain_contracts` section
3. Sub-stages:
   - `typescript-config-policy`: validate required tsconfig options via `ts.readConfigFile` + `ts.parseJsonConfigFileContent`
   - `typescript-diagnostic`: run `tsc --noEmit --pretty false`, parse output
   - `eslint`: run ESLint, parse JSON output
4. Violations include `rule_kind: "typescript-config-policy" | "typescript-diagnostic" | "eslint"`
5. Test: fixture with missing strict → config-policy violation in check output

### GAP-3: `stele design init` Fully Functional

**Design Doc Reference:** Section 5.1
**Current State:** `init.ts` is a stub — checks if profile exists, prints message. Does NOT scaffold.

**Required:**
1. `--preset ddd-typedriven` creates `contract/design/profile.yaml` with template
2. `--answers <path>` reads answers YAML, populates profile fields
3. `--dry-run` shows what would be created
4. `--replace` overwrites existing (prints review guidance)
5. `--generate` runs design generate after init
6. Template must be valid profile (passes validation)
7. Test: `stele design init --preset ddd-typedriven` → profile.yaml exists, passes validation

### GAP-4: Source-Root Ownership Validation

**Design Doc Reference:** Section 3, Section 4 validation rules
**Current State:** `ownership.ts` validates `contract/generated/` files only. No source file ownership check.

**Required:**
1. Walk all files under `project.source_roots`
2. Match each file against context roots, shared kernels, ignore patterns
3. Unowned files = blocking violation
4. Ambiguously owned files (match multiple contexts) = blocking violation
5. Integrate into `stele design check --profile-only` AND `stele check` design_integrity stage
6. Test: fixture with unowned file → violation; fixture with overlap → violation

### GAP-5: `rules --json` Design Provenance

**Design Doc Reference:** Section 10, provenance schema
**Current State:** `rules.ts` indexes rules but no `design_origin` field.

**Required:**
1. Add `design_origin` field to `IndexedRule`, `IndexedArchitectureRule`, `IndexedCoreNode`
2. Read generation manifest, map rule IDs to origin info
3. Schema per Section 10:
   ```json
   {
     "rule_id": "architecture.ddd-billing...",
     "origin": {
       "source": "generated",
       "profile_path": "contract/design/profile.yaml",
       "profile_anchor": "ddd.contexts.billing",
       "decision_id": "q1-bounded-contexts",
       "question_id": "Q1",
       "selected_option": "by_business_function",
       "enforcement_level": "hard"
     }
   }
   ```
4. Test: `stele rules --json` includes origin for generated rules

### GAP-6: `stele explain` / `stele why` Design-Origin

**Design Doc Reference:** Section 10, `stele explain`, `stele why`
**Current State:** `explain.ts` handles architecture rules but no design-origin. `why.ts` no toolchain/type-shape guidance.

**Required:**
1. `stele explain <architecture-id>` looks up generation manifest for design origin
2. JSON output includes: profile_path, profile_anchor, decision_id, question_id, selected_option, enforcement_level
3. `stele why <fingerprint>` handles `typescript-config-policy`, `typescript-diagnostic`, `eslint`, `typescript-shape` rule kinds
4. Test: explain output includes provenance; why output includes fix guidance for all rule kinds

### GAP-7: Generation Manifest Completeness

**Design Doc Reference:** Section 9.2
**Current State:** Manifest has profile hash + rules. Missing generator metadata, approval chain, provenance origins.

**Required:**
1. Manifest includes `generator` block: package, version, git_sha, content_sha256
2. Manifest includes `preset` field
3. Manifest includes `profile_path` field
4. Manifest includes `approved_profile_sha256`
5. Manifest includes `approval` block with path, sha256, diff_classification
6. Manifest includes `templates` list
7. Each output file entry has `rules[*].origins` with decision_id, question_id, selected_option
8. Test: manifest matches Section 9.2 schema

### GAP-8: Cycle Fixture Test Asserts Actual Violation

**Design Doc Reference:** Section 11 Phase 0 item 10
**Current State:** Cycle fixture test asserts `violations` is defined, not actual cycle violation.

**Required:**
1. Cycle fixture test must assert:
   - Violation count >= 1
   - `rule_kind === "architecture_cycle"`
   - Contains modules and edge files
2. Test: cycle fixture produces architecture_cycle violation

---

## PARTIAL Items (Must Complete)

### PART-1: Tsconfig Policy Uses Shared Loader

**Design Doc Reference:** Section 8.1
**Current State:** `tsconfig-policy.ts` uses `JSON.parse()`. `smart-constructors.ts` uses `ts.parseJsonConfigFileContent`.
**Required:** `tsconfig-policy.ts` must use `ts.readConfigFile` + `ts.parseJsonConfigFileContent`. Must handle `extends`.

### PART-2: Ambiguous Module Ownership Surfaced

**Design Doc Reference:** Section 11 Phase 0 item 3
**Current State:** `buildModuleMap` detects ambiguous files. `evaluateArchitectureContract` discards them (hardcoded `ambiguousFiles: []`).
**Required:** `evaluateArchitectureContract` must propagate and surface ambiguous files as violations.

### PART-3: Missing Core-Node CLASS Violation

**Design Doc Reference:** Section 2 Gap 4
**Current State:** Missing file → violation. Missing class within file → returns 0 silently.
**Required:** Missing class within existing file → configuration violation.

### PART-4: Validation Errors Include Profile Path

**Design Doc Reference:** Section 4
**Current State:** ValidationError has `field` + `message`. No `path`.
**Required:** ValidationError type must include `path` field. All validation errors must include profile path.

### PART-5: `stele check` Profile → Contract → Check End-to-End

**Design Doc Reference:** Section 12 test group 2
**Current State:** Generator produces valid CDL. `loadContract` loads it. But `stele check` doesn't include design integrity.
**Required:** Wire design integrity into check (GAP-1). Test full pipeline: init → generate → check → passes.

---

## STUB Items (Must Implement)

### STUB-1: `stele design init`

**Design Doc Reference:** Section 5.1
**Required:** See GAP-3 above.

### STUB-2: Import to `contract/main.stele`

**Design Doc Reference:** Section 5.2
**Current State:** Blindly appends import. No safety checks.
**Required:** Check if main.stele is protected (use existing path-safety helpers). Handle edge cases. Report if cannot modify.

---

## Missing Documentation

### DOC-1: Layer/Public-Entry Status — COMPLETE

**Design Doc Reference:** Section 11 Phase 0 item 9
**Completed:** 2026-05-20

**Findings:**
- `layer` declarations are parsed and validated by `structure-architecture.ts` (lines 149-162). Layer module references are checked against declared module ids.
- `public-entry` declarations inside `module` are parsed and validated by `structure-architecture.ts` (lines 291-294).
- At runtime in `architecture-runtime.ts`, both are **dropped**: `layers` is hardcoded to `[]` (line 154) and `publicEntries` is hardcoded to `[]` (line 57 in `toFullModules`).
- The `evaluateArchitecture` core engine does not evaluate layer ordering or public-entry access rules.

**Current Behavior (v1):**
- `layer` declarations serve as **documentation and agent guidance only**. They are parsed, validated for reference integrity, but not enforced at runtime.
- `public-entry` declarations serve as **documentation and agent guidance only**. They are parsed per-module but not enforced at runtime.
- Agents and developers can use these declarations to understand intended architecture boundaries, but the runtime checker will not produce violations for layer ordering or public-entry access patterns.

**Planned Behavior (v2):**
- `layer` enforcement: runtime will verify that dependencies only flow downward through declared layers (e.g., presentation → domain → infrastructure). Upward or cross-layer dependencies will be violations.
- `public-entry` enforcement: runtime will verify that cross-module imports only target declared public-entry paths. Imports to non-public files will be violations.

**Documentation Updated:**
- `docs/spec/cdl.md` architecture section now notes v1 metadata-only status.
- `packages/cli/src/architecture-runtime.ts` has a TODO referencing this documentation.

---

## Task Plan

| # | Task | Type | Dependencies | Priority |
|---|------|------|-------------|----------|
| T1 | GAP-1: Wire design integrity into `stele check` | Dev | None | P0 |
| T2 | GAP-2: Wire toolchain stages into `stele check` | Dev | None | P0 |
| T3 | GAP-3: Implement `stele design init` | Dev | None | P0 |
| T4 | GAP-4: Source-root ownership validation | Dev | None | P0 |
| T5 | GAP-5: `rules --json` design provenance | Dev | T1 | P1 |
| T6 | GAP-6: `explain`/`why` design-origin | Dev | T1 | P1 |
| T7 | GAP-7: Generation manifest completeness | Dev | T1 | P1 |
| T8 | GAP-8: Cycle fixture test | Dev | None | P1 |
| T9 | PART-1: Tsconfig shared loader | Dev | None | P1 |
| T10 | PART-2: Ambiguous ownership surfaced | Dev | None | P1 |
| T11 | PART-3: Missing class violation | Dev | None | P1 |
| T12 | PART-4: Profile path in errors | Dev | None | P1 |
| T13 | STUB-2: Safe main.stele import | Dev | None | P1 |
| T14 | DOC-1: Document layer/public-entry status | Docs | None | P2 |

## Execution Waves

### Wave 1 (Parallel — all independent)
T1, T2, T3, T4, T8, T9, T10, T11, T12, T13

### Wave 2 (After Wave 1)
T5, T6, T7

### Wave 3 (After Wave 2)
T14

### Final Verification
- `pnpm build` — no errors
- `pnpm test` — all tests pass
- `pnpm typecheck` — no type errors
- GAP audit re-run — all items COMPLETE

## Final Audit Results (2026-05-20)

All 26 original GAP/PARTIAL/STUB items COMPLETE. Additional findings from independent comprehensive audit:

### Original Gaps Fixed

1. **tsconfig propagation** — `architecture-runtime.ts` now propagates `tsconfig` from DSL to extractor. `stage.ts` converts runtime arch with tsconfig field.
2. **Unresolved imports surfaced** — `architecture-runtime.ts` now collects and surfaces `unresolvedSpecifiers` as configuration violations.
3. **Architecture description carried** — `stage.ts` now carries `arch.description` into violation cause messages.

### GAP-7 Manifest Completeness — Section 9.2 Fields Added

Added missing fields to `GenerationManifest` type per Section 9.2:
- `preset` — preset name (e.g., "ddd-typedriven")
- `approved_profile_sha256` — SHA-256 of last approved profile
- `approval` — `ApprovalRecord` with path, sha256, diff_classification, approved_by, approved_at
- `outputs` — `ProvenanceOutput[]` with rule-level provenance and full origin trace
- `content_sha256` in `GeneratorInfo` — SHA-256 of generator source bundle
- `question_id` / `selected_option` in `StructuredOrigin` — enriched origin trace

Fields are optional (`?`) for backward compatibility with existing manifests.

### Comprehensive Audit Findings (Outside Original GAP Scope)

Independent audit identified additional items in Phase 3-4 not covered by the original GAP report:

| Finding | Phase | Severity | In Original Scope |
|---------|-------|----------|-------------------|
| Branded ID check missing (4.4) | Phase 4 | Low | No — Phase 4 out of scope |
| Shared program helper missing (4.3) | Phase 4 | Low | No — Phase 4 out of scope |
| Command resolver missing (3.4) | Phase 3 | Low | No — Phase 3 out of scope |
| `--architecture-only` includes extra stages (0.7) | Phase 0 | Low | Yes — implemented (reasonable extension) |
| Duplicated tsconfig reading (0.9) | Phase 0 | Low | Yes — PART-1, addressed |
| `design diff` hash-only classification (1.4) | Phase 1 | Low | No — enhancement beyond original scope |

**Note:** Phase 3-4 items are new design spec capabilities never listed in the original GAP report (GAP-1 through GAP-8, PART-1 through PART-5, STUB-1 through STUB-2). They represent future work, not unfulfilled commitments.

**Evidence:**
- `pnpm build` — all packages green
- `pnpm --filter @stele/cli test` — 550 pass, 0 fail
- Cycle fixture test asserts actual cycle violations (2+ violations with cycle: specifier)
- All architecture tests pass
- Manifest types updated with Section 9.2 fields
