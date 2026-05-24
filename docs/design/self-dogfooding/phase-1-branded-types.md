# Phase 1 — branded-id / smart-ctor Real Adoption

**Goal:** Convert ~200 raw `string` usages of 5 domain ids
(RuleId / ContractPath / Sha256 / CommandName / PackageName) to
nominal branded types, forcing every construction through a smart
constructor that validates the value's shape.

**Why:** Today `packages/core/src/util/branded-types.ts` defines the
5 branded types + smart constructors. `contract/generated/ddd-typedriven.stele`
declares 4 `(branded-id ...)` + 3 `(smart-ctor ...)`. The
`type-driven-evaluator` is wired into `stele check`. **But every
single TS source file in this repo still uses raw `string` for these
ids**. The evaluator runs, finds nothing to check, and we get a
green build that's enforcing nothing.

**Estimated effort:** 3–4 working days.

**Out of scope:**
- Any of the other 11 branded types we might invent (e.g. `InvariantId`,
  `OperatorId`). Stick to the 5 already declared + 1 new
  (`CheckerName`).
- Phase B contracts (later phases)
- Architecture changes
- Adding branded types to non-TS source (Python checkers)

## Scope summary

For each of the 5 branded types:

1. Add a `branded-id` + `smart-ctor` declaration to `contract/main.stele`
   (or rather, ensure the auto-generated `ddd-typedriven.stele` covers
   all 5 — today it has 4; add `CommandName`)
2. Find every site that creates or assigns this type as a raw string
3. Replace with `<smartCtor>(value)` call OR with `type` narrowing
4. Add a Python self-protection checker that scans TS source and
   verifies the type's call sites all go through the smart constructor
5. Add a negative test that introduces a regression and catches it

## Required architectural changes

### Step 1.1 — Ensure all 5 branded types are declared in CDL

**Current state** (verify):

```
grep "^(branded-id " contract/generated/ddd-typedriven.stele
# expected: 4 entries — RuleId, ContractPath, Sha256, PackageName
```

`CommandName` is missing. Add it to `contract/design/profile.yaml`
under `type_driven.branded_ids.declarations`:

```yaml
type_driven:
  branded_ids:
    declarations:
      - id: CommandName
        target: "packages/core/src/util/branded-types.ts::CommandName"
        base_type: string
        pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$"
  smart_ctors:
    declarations:
      - id: CommandName
        constructor: commandName
        deny_raw: true
        target: "packages/core/src/util/branded-types.ts::CommandName"
```

Then: `stele design propose ...` (or direct edit) → approve → generate.

**Acceptance:** `contract/generated/ddd-typedriven.stele` now has 5
`branded-id` + 5 `smart-ctor` (4 → 5 of each, +1).

### Step 1.2 — Replace RuleId call sites (highest volume)

**Target type:** `RuleId` — `"stele:*"` or `"custom:*"` formatted IDs.

**Verified call-site count at planning time:**

```
grep -rn "rule_id:\|ruleId:" packages/core/src packages/cli/src packages/agent-hooks/src | grep -v ".test.\|dist/" | wc -l
# 58 matches (43 of those in packages/cli/src)
```

**Reviewer V-07 fix — TEMPLATE LITERAL cases:**
A non-trivial fraction of sites assign a TEMPLATE LITERAL (backtick
string), not a plain string. E.g. `packages/cli/src/architecture/stage.ts`
has `` rule_id: `architecture.${arch.id}.${v.fromModule}` ``. These
MUST be wrapped — `` rule_id: ruleId(`architecture.${arch.id}.${v.fromModule}`) `` —
or the smart-constructor guarantee is bypassed silently.

The pattern-validation regex inside `ruleId(...)` must accept the
output format of these template literals (e.g. `architecture.<id>.<name>`).
Either:
- Widen the `isValidRuleId` regex to accept `^[a-z][a-z0-9.-]*:[A-Za-z0-9._-]+$|^architecture\..+$`
- OR introduce a dedicated `architectureRuleId(...)` smart constructor
  for the architecture stage

Decision: widen the regex (single-helper preferred over per-domain helpers).

**Strategy per site:**
- Plain string literal: `rule_id: "stele:foo"` → `rule_id: ruleId("stele:foo")`
- Template literal: `` rule_id: `prefix.${x}` `` → `` rule_id: ruleId(`prefix.${x}`) ``
- Parameter-typed value: change the parameter type from `string` to `RuleId`;
  callers must call `ruleId(...)` at their construction point
- CDL-parser-returned value: wrap with `ruleId(...)` at the parser boundary
  (`packages/core/src/validator/structure-invariant.ts` etc.)

**Tooling:** Use `pnpm typecheck` after each batch (5–10 sites at a
time) to catch cascading type errors.

**Acceptance after Step 1.2:**

Run BOTH grep forms — the original (plain) AND the template-literal form:

```bash
# Plain string assignments not wrapped:
grep -n 'rule_id:.*"' packages/core/src packages/cli/src | grep -v 'ruleId(' | grep -v 'as RuleId' | grep -v '\.test\.' | wc -l
# Template-literal assignments not wrapped:
grep -nE 'rule_id:\s*`' packages/core/src packages/cli/src | grep -v 'ruleId(' | grep -v '\.test\.' | wc -l
```

Both counts must be 0.

- All vitest suites pass
- `pnpm typecheck` clean

### Step 1.3 — Replace Sha256 call sites

**Target type:** `Sha256` — 64-char lowercase hex strings.

**Likely call sites:**
- `packages/core/src/manifest/manifest.ts` — protected_files entries
- `packages/core/src/manifest/hash-manifest.ts` — transitive_hash values
- `packages/cli/src/commands/check.ts` — contract hash
- `packages/cli/src/commands/lock.ts` — manifest hash compute

**Strategy:** Where the value comes from `createHash("sha256").digest("hex")`,
wrap in `sha256(...)`. Where it's compared against a stored value,
the stored value is also `Sha256` (transitive narrowing).

**WARNING:** The project already has a local `function sha256(value: string): string`
in `packages/core/src/manifest/hash-manifest.ts` and another in
`packages/cli/src/commands/generate.ts`. These are PURE HASH FUNCTIONS,
not the smart constructor. **Don't conflate the two.** Rename the
local hash function to `computeSha256(value: string): Sha256` so it
returns the branded type AND validates the output shape.

**Acceptance:** all locations that store a SHA-256 string have type
`Sha256`, not `string`. Run:

```
grep -rn "sha256\|hash.*sha\|protected_files\[" packages/core/src packages/cli/src | grep -v ".test.\|dist/" | wc -l
```

every match should either pass through a smart constructor or be
typed as `Sha256`.

### Step 1.4 — Replace ContractPath call sites

**Target type:** `ContractPath` — paths to `.stele` files.

**Likely call sites:**
- `packages/core/src/loader/load-contract.ts` (entry)
- `packages/cli/src/commands/init.ts` (creates `contract/main.stele`)
- `packages/cli/src/commands/explain.ts` (references contract files by path)

### Step 1.5 — Replace CommandName call sites

**Target type:** `CommandName` — lowercase-dashed CLI command names.

**Likely call sites:**
- `packages/cli/src/index.ts` — every `program.command("...")` call
- Test fixtures referring to commands by name

### Step 1.6 — Replace PackageName call sites

**Target type:** `PackageName` — npm package names.

**Likely call sites:**
- `packages/cli/src/backend-registry.ts` — `REGISTERED_BACKENDS`
- `packages/core/src/config/defaults.ts` — `packages/*` patterns
- `contract/checker_impls/self_protection.py` — references like `"@stele/cli"` (Python side; not affected — branded types are TS-only)

### Step 1.7 — Add Python self-protection checker

**File:** `contract/checker_impls/self_protection.py`

Add 5 checkers (one per branded type), e.g.:

```python
_RULE_ID_VIOLATION_RE = re.compile(
    # `rule_id: "stele:xxx"` or `rule_id = "xxx"` without ruleId() wrap.
    # Conservative: only matches string-literal RHS assignments.
    r'\brule_id\s*[:=]\s*"[^"]+"',
)

def rule_id_uses_branded_type(ctx, **_):
    violations = []
    for src in _walk_typescript_sources():
        rel = str(src.relative_to(_REPO_ROOT))
        if rel == "packages/core/src/util/branded-types.ts":
            continue
        content = src.read_text(encoding="utf-8", errors="replace")
        stripped = _strip_ts_comments_and_strings(content)
        # A violation is a `rule_id: "..."` site that is not wrapped in `ruleId(...)`.
        # Since string-blanker erases string literals, the regex won't match if
        # we use the blanked form — we need a different approach.
        # Approach: find every `rule_id` field declaration / assignment in the
        # un-blanked source, then check that the value side either:
        #   (a) is a call to `ruleId(...)`
        #   (b) is a reference to a variable typed as `RuleId`
        #   (c) is wrapped in `as RuleId` (allow cast at parser boundary if explicitly typed)
        for m in re.finditer(r"\brule_id\s*[:=]\s*([^,;\n]+)", content):
            value_expr = m.group(1).strip()
            if value_expr.startswith("ruleId("):
                continue
            # Allow if value is just an identifier (typed elsewhere)
            if re.fullmatch(r"[A-Za-z_$][\w$]*", value_expr):
                continue
            # Allow `... as RuleId`
            if value_expr.endswith(" as RuleId"):
                continue
            # Otherwise — a raw string literal or expression is suspect.
            line_no = content.count("\n", 0, m.start()) + 1
            violations.append({"file": rel, "line": line_no, "message": f"`rule_id` assigned without ruleId(): {value_expr[:80]}"})
    if violations:
        return {"passed": False, "message": f"{len(violations)} rule_id sites without smart-constructor wrap: " + "; ".join(f"{v['file']}:{v['line']}" for v in violations[:5]), "violations": violations}
    return {"passed": True, "message": None, "violations": []}
```

Repeat the same shape for `sha256`, `contract_path`, `command_name`,
`package_name`. Field names to scan:
- `Sha256`: scan fields named `sha256`, `transitive_hash`, `contract_hash`, `output_hashes_global` (values), `methodResolutionHash`, `fingerprint` (note: fingerprint may be short, exempt)
- `ContractPath`: scan fields named `entry`, `filePath` when the file ends in `.stele`
- `CommandName`: scan `program.command(...)` first arg
- `PackageName`: scan `REGISTERED_BACKENDS` `packageName` field

### Step 1.8 — Register 5 new invariants in `contract/main.stele`

```lisp
(checker rule-id-uses-branded-type
  (description "Every assignment to a `rule_id` field (or local variable typed as RuleId) must go through ruleId() smart constructor — no raw string literals. Branded types from packages/core/src/util/branded-types.ts."))

(invariant RULE_ID_USES_BRANDED_TYPE
  (severity error)
  (description "Phase 1 (self-dogfooding): RuleId branded type must be the only way to construct a rule identifier in TS source. Catches `rule_id: \"stele:foo\"` raw-string assignments.")
  (uses-checker rule-id-uses-branded-type))
```

Repeat for the other 4 branded types.

### Step 1.9 — Register 5 negative tests in `contract/checker_impls/test_negative.py`

Each test:
1. Inject a raw `rule_id: "stele:test"` into an existing TS file
2. Run checker
3. Assert passed=False
4. Restore

### Step 1.10 — Re-lock + verify

```
pnpm build
node packages/cli/dist/index.js generate --force
node packages/cli/dist/index.js lock --reason "Phase 1: branded-id/smart-ctor real adoption"
node packages/cli/dist/index.js check     # exit 0, ~48 invariants
.venv/bin/python -m pytest tests/contract -q
.venv/bin/python contract/checker_impls/test_negative.py
pnpm test
```

## Acceptance criteria

- [ ] 5 `branded-id` + 5 `smart-ctor` declarations exist in
      `contract/generated/ddd-typedriven.stele` (was 4 + 3)
- [ ] 5 new invariants added (RULE_ID_USES_BRANDED_TYPE et al)
- [ ] 5 new Python checkers added
- [ ] 5 new negative tests added
- [ ] Every `rule_id: "..."` assignment in TS source goes through `ruleId(...)`
- [ ] Every `sha256: "..."` ditto
- [ ] Every `contractPath: "..."` ditto
- [ ] Every `commandName: "..."` (i.e. `.command("foo")` first arg) ditto
- [ ] Every `packageName: "@stele/..."` ditto
- [ ] No `as RuleId` / `as Sha256` casts EXCEPT at single parser-boundary sites
      (document each exception in commit msg)
- [ ] `pnpm typecheck` clean
- [ ] All vitest suites pass
- [ ] `stele check` exit 0 with ~48 invariants (was 43 after Phase 0)

## Rollback strategy

If a particular branded-type rollout breaks too much:

1. Revert that single type's commits (Phase 1 should be split into
   5 commits, one per type)
2. Land the rest
3. File the failed type as a follow-up

## Dependencies

- Phase 0 not required (this phase is independent — branded types
  use existing `type-driven-evaluator` infrastructure which already
  handles TS source even when `targetLanguage = "python"` for the
  config-wide setting)

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding/README.md and
docs/design/self-dogfooding/phase-1-branded-types.md.

Land Step 1.1 (CommandName declaration) first as a single commit.
Then land Steps 1.2 through 1.6 in five separate commits, one per
branded type. Steps 1.7–1.10 in one final commit.

Run CC-3 after every commit. If `pnpm typecheck` reports >5 errors,
stop and surface them — don't try to fix more than 5 at once.
```
