# Phase 0 — Multi-Language Phase Config Infrastructure

**Goal:** Let a single Stele project declare different target
languages for different stages (Phase A test generation vs. Phase B
trace/type-state/effect evaluation vs. code-shape evaluation), without
breaking the existing single-language defaults.

**Why first:** Phases 3 / 4 / 5 cannot land otherwise — they need
`targetLanguage: "typescript"` for Stele's own TS source but THIS
project's tests run under pytest, requiring `targetLanguage: "python"`
overall.

**Estimated effort:** 1.5–2 working days.

**Out of scope:**
- Changing the `targetLanguage` value of THIS repo (CC-9)
- Cross-language test-framework dispatch (e.g. mixing pytest + vitest
  in one repo)
- Per-invariant language override (only per-phase)

## Scope summary

Add an optional `phaseLanguages` field to `stele.config.json` and to
the `Config` type in `@stele/core`. The three Phase B check-stages
and the architecture stage read this field first, falling back to the
existing `targetLanguage` when the field is absent.

## Required architectural changes

### Step 0.1 — Extend the Config type

**File:** `packages/core/src/config/types.ts` (find or create)

Add to the `Config` type:

```ts
export interface PhaseLanguages {
  /** Phase B trace-policy evaluator language. Defaults to targetLanguage. */
  trace?: SupportedLanguage;
  /** Phase B type-state evaluator language. Defaults to targetLanguage. */
  typeState?: SupportedLanguage;
  /** Phase B effect evaluator language. Defaults to targetLanguage. */
  effect?: SupportedLanguage;
  /** Code-shape default language. Each (boundary)/(class-shape)/... declaration
   *  may still override via its own `(lang …)` field. */
  codeShape?: SupportedLanguage;
  /** Architecture import-extractor language. Defaults to targetLanguage. */
  architecture?: SupportedLanguage;
}

export interface Config {
  // ... existing fields ...
  phaseLanguages?: PhaseLanguages;
  /** Path to tsconfig.json, relative to project root. Defaults to "tsconfig.json".
   *  Required when any phaseLanguages.* is "typescript" and the default doesn't exist. */
  tsconfig?: string;
}
```

`SupportedLanguage` already exists in `@stele/call-graph-core/src/types.ts`.

**Acceptance:** `tsc --noEmit` on `@stele/core` clean.

### Step 0.2 — Update Config schema validator

**File:** `packages/core/src/config/validate.ts` (or `config-schema-valid` checker)

Validate that:
- `phaseLanguages` is an object if present
- Each of its keys is one of `{trace, typeState, effect, codeShape, architecture}`
- Each value is one of the 5 supported languages
- `tsconfig` is a non-empty string if present

Update `contract/checker_impls/self_protection.py::config_schema_valid` to recognize the new optional fields (don't reject them).

**Acceptance:** existing `CONFIG_SCHEMA_VALID` invariant continues to pass; rejecting an invalid `phaseLanguages: {trace: "elixir"}` test passes.

### Step 0.3 — Helper: `pickPhaseLanguage(config, phase)`

**File:** `packages/core/src/config/phase-language.ts` (new)

```ts
import type { Config } from "./types.js";
import type { SupportedLanguage } from "@stele/call-graph-core";

export type PhaseName = "trace" | "typeState" | "effect" | "codeShape" | "architecture";

/**
 * Resolve the target language for a given phase. Returns the
 * per-phase override when set, else the config-wide targetLanguage.
 */
export function pickPhaseLanguage(config: Config, phase: PhaseName): SupportedLanguage {
  const override = config.phaseLanguages?.[phase];
  if (override !== undefined) return override;
  return config.targetLanguage as SupportedLanguage;
}
```

Export it from `@stele/core/src/index.ts`.

**Acceptance:** unit test in `packages/core/tests/phase-language.test.ts`:

```ts
it("returns per-phase override when set", () => {
  expect(pickPhaseLanguage({ targetLanguage: "python", phaseLanguages: { trace: "typescript" } }, "trace")).toBe("typescript");
});
it("falls back to targetLanguage when override absent", () => {
  expect(pickPhaseLanguage({ targetLanguage: "python" }, "trace")).toBe("python");
});
```

### Step 0.4 — Update the three Phase B stages

**Files:**
- `packages/cli/src/commands/check-stages-trace.ts`
- `packages/cli/src/commands/check-stages-type-state.ts`
- `packages/cli/src/commands/check-stages-effect.ts`

In each file, change:

```ts
const language = context.config.targetLanguage;
```

to:

```ts
import { pickPhaseLanguage } from "@stele/core";
const language = pickPhaseLanguage(context.config, /* "trace" | "typeState" | "effect" */);
```

Also: when `language === "typescript"`, the tsconfig path resolution
(`resolveTsconfigPath`) should honour `context.config.tsconfig` BEFORE
falling back to `tsconfig.json` at project root. Already partially
done — verify.

**Acceptance:** existing trace/effect/type-state tests still pass; new
test asserting that `phaseLanguages.trace = "typescript"` overrides
the python `targetLanguage`.

### Step 0.5 — Update the architecture stage

**File:** `packages/cli/src/architecture/stage.ts`

The architecture stage currently uses `(architecture …)` declarations'
own `(lang …)` field. Add a layer: when the declaration does NOT
specify `(lang …)`, fall back to `pickPhaseLanguage(config, "architecture")`.

(In practice all our architectures have `(lang typescript)` explicitly,
so this is forward-compat plumbing.)

### Step 0.6 — Update the code-shape stage

**File:** `packages/cli/src/commands/check-stages-code-shape.ts`
(or wherever code-shape dispatches; today it's via `evaluateCodeShapes`
in `packages/cli/src/code-shape/evaluate.ts`)

Code-shape already dispatches per-declaration on `declaration.lang`.
So `phaseLanguages.codeShape` only affects the DEFAULT when a
declaration has no `(lang …)` — which is currently impossible because
parseLang treats lang as required. Leave the dispatch alone but add a
note in CDL spec that `lang` may be omitted in future versions.

For Phase 0: no change needed — the field is declared for forward-compat.

### Step 0.7 — Update `stele.config.json` for THIS repo

**File:** `stele.config.json`

Add:

```jsonc
{
  // ... existing fields (DO NOT REMOVE targetLanguage) ...
  "tsconfig": "tsconfig.base.json",
  "phaseLanguages": {
    "trace": "typescript",
    "typeState": "typescript",
    "effect": "typescript",
    "architecture": "typescript"
  }
}
```

This is the config that lets later phases write TS Phase B contracts
for this repo. `targetLanguage` stays `"python"` (CC-9).

**Acceptance:** `node packages/cli/dist/index.js check` exits 0
(but `targetLanguage` is still "python" — verify with
`cat stele.config.json | jq .targetLanguage`).

### Step 0.8 — Self-protection invariant: phase-language consistency

**File:** `contract/main.stele`

```lisp
(checker phase-language-config-valid
  (description "stele.config.json `phaseLanguages` field must be an object with keys in {trace, typeState, effect, codeShape, architecture} and values in {typescript, python, go, rust, java}."))

(invariant PHASE_LANGUAGE_CONFIG_VALID
  (severity error)
  (description "Phase 0 (self-dogfooding plan): the per-phase language override field, when set, must be type-correct so that downstream check-stages dispatch deterministically.")
  (uses-checker phase-language-config-valid))
```

**Checker implementation** in `contract/checker_impls/self_protection.py`:

```python
def phase_language_config_valid(ctx, **_):
    config_path = _REPO_ROOT / "stele.config.json"
    if not config_path.exists():
        return {"passed": True, "message": "no config (acceptable for non-adopter mode)"}
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    pl = raw.get("phaseLanguages")
    if pl is None:
        return {"passed": True, "message": None}
    if not isinstance(pl, dict):
        return {"passed": False, "message": "phaseLanguages must be an object"}
    valid_keys = {"trace", "typeState", "effect", "codeShape", "architecture"}
    valid_langs = {"typescript", "python", "go", "rust", "java"}
    for k, v in pl.items():
        if k not in valid_keys:
            return {"passed": False, "message": f"phaseLanguages key `{k}` not in {sorted(valid_keys)}"}
        if v not in valid_langs:
            return {"passed": False, "message": f"phaseLanguages.{k} = `{v}` not in {sorted(valid_langs)}"}
    return {"passed": True, "message": None}
```

Register the checker name in `tests/contract/conftest.py` and the
hyphen-to-underscore map.

### Step 0.9 — Negative tests

**File:** `contract/checker_impls/test_negative.py`

Add 2 negative tests:

1. `test_phase_language_config_valid_rejects_bad_key`:
   - Backup `stele.config.json`
   - Inject `phaseLanguages: {invalid_key: "typescript"}`
   - Assert checker returns passed=False
   - Restore

2. `test_phase_language_config_valid_rejects_bad_lang`:
   - Inject `phaseLanguages: {trace: "elixir"}`
   - Assert checker returns passed=False
   - Restore

### Step 0.10 — Re-lock manifest + check + pytest

```
pnpm build
node packages/cli/dist/index.js generate --force
node packages/cli/dist/index.js lock --reason "Phase 0: multi-language config infrastructure"
node packages/cli/dist/index.js check     # must exit 0
.venv/bin/python -m pytest tests/contract -q   # 43/43 (was 42)
.venv/bin/python contract/checker_impls/test_negative.py  # 61/61 (was 59)
```

## Acceptance criteria summary

- [ ] `Config` type has `phaseLanguages?` + `tsconfig?` fields
- [ ] `pickPhaseLanguage(config, phase)` helper exists + exported + unit-tested
- [ ] 3 Phase B stages + architecture stage call `pickPhaseLanguage`
- [ ] `stele.config.json` declares `phaseLanguages` for trace/typeState/effect/architecture = typescript
- [ ] `targetLanguage` STILL = `"python"` (CC-9)
- [ ] 1 new invariant: `PHASE_LANGUAGE_CONFIG_VALID`
- [ ] 2 new negative tests
- [ ] `stele check`: 43 invariants, exit 0
- [ ] All vitest suites pass
- [ ] Manifest locked + committed

## Rollback strategy

If Phase 0 introduces regression:

1. `git revert <phase-0-commit>`
2. `pnpm install && pnpm build`
3. Verify `stele check` exit 0
4. File the failure mode as a design issue for re-planning

## Cross-phase invariants preserved

After Phase 0:
- `stele.config.json::targetLanguage === "python"` (CC-9)
- `pytest tests/contract` passes (no test-runner switch)
- All Round 13 / Round 14 invariants pass

## Sub-agent execution prompt

When a sub-agent is dispatched to execute Phase 0, the main agent
passes:

```
Read docs/design/self-dogfooding/README.md (cross-cutting rules) and
docs/design/self-dogfooding/phase-0-multi-language-config.md (this file).
Execute every step in order. Run CC-3 between steps. Surface any
ambiguity by stopping and asking the main agent — do not improvise.
Return a completion report listing each step's outcome.
```
