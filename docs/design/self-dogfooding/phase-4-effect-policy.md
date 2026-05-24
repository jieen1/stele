# Phase 4 — Effect Policy Adoption (Alphabet + Annotations + 5 Policies)

**Goal:** Declare the project's effect alphabet, annotate every public
function in `@stele/core` with its effect set, and write 5
`effect-policy` contracts enforcing purity / network-freedom / etc.

**Why:** The existing `CORE_ENGINE_PURITY` Python checker scans for
specific call patterns (`Date.now`, `Math.random`, etc.). That's a
proxy for "does this function have side effects". The proper
mechanism is `effect-policy`: declare the effect alphabet, label every
function, and let the evaluator propagate effects through the call
graph. This Phase upgrades the proxy to the real thing.

**Estimated effort:** 3–4 working days.

**Out of scope:**
- Effect policies on `@stele/cli` beyond the 1 generator policy listed
- Effect annotations on Python source (the Python CallGraph extractor
  already reads `@stele:effects` from decorators / docstrings, but
  Phase 4 focuses on TS)
- Removing the `CORE_ENGINE_PURITY` Python checker (keep as
  defence-in-depth)

## Required dependency

**Phase 0** (`phaseLanguages.effect = "typescript"`).

## Scope summary

1. Declare the effect alphabet (Step 4.1)
2. Annotate effects on @stele/core public APIs (Step 4.2)
3. Write 4 `effect-policy` contracts (Step 4.3)
4. Add 1 `effect-suppression` for hash-manifest.ts's legitimate
   `fs.write + time + random` use (Step 4.4)
5. Add 4 negative tests (Step 4.5)

## The 4 effect policies

### Step 4.1 — `effect-declarations`

**Reviewer V-03 / V-04 fix:**
- Dotted effect names (`fs.read`, `crypto.hash`) MUST be string
  literals — CDL identifier alphabet is `[A-Za-z_]` start +
  `[A-Za-z0-9_-]` part (`packages/core/src/lexer/lexer.ts:297–303`).
  Bare `pure` / `time` / `random` / `env` / `network` / `process`
  are fine. `child-process` is fine (`-` is in alphabet).
- `pure` is NOT declared. Per the effect-system spec, "pure" is
  the *absence* of any declared effect; a node with `effects: []`
  is pure by construction.

```lisp
(effect-declarations
  (effect "fs.read")        ; readFile, readdirSync, stat
  (effect "fs.write")       ; writeFile, rename, unlink, mkdir
  (effect time)             ; Date.now, performance.now, setTimeout
  (effect random)           ; Math.random, crypto.random*
  (effect env)              ; process.env access
  (effect network)          ; http / fetch / dns
  (effect "crypto.hash")    ; deterministic hashing (createHash is pure given input)
  (effect process)          ; process.exit, process.cwd, process.argv
  (effect child-process))   ; execFile, spawn
```

### Step 4.2 — `effect-annotation` (per public API)

Annotate every public function in `@stele/core` with its effect set
via JSDoc `@stele:effects` tags. The `tsEffectAnnotationExtractor`
reads these and merges them with CDL-declared annotations.

**Strategy:** Add JSDoc to ~40 public exports in `@stele/core/src/`.
Most will be `@stele:effects pure`. Exceptions:

| Function | Effects |
|---|---|
| `writeAtomic` (manifest/hash-manifest.ts) | `fs.write`, `time`, `random` |
| `readHashManifest` | `fs.read` |
| `writeHashManifest` | `fs.write` (calls writeAtomic) |
| `writeManifest` | `fs.write` |
| `verifyManifest` | `fs.read` |
| `loadContract` | `fs.read` |
| `parseFile` | `pure` (operates on already-read string) |
| `normalizeContract` | `pure` |
| `coordinateGeneration` | `pure` |
| `createHash`/`sha256OfFileOrNull` | `fs.read` (the latter), `pure` (the former) |
| `hashManifestSha256` | `pure` |

### Step 4.3 — Write 4 `effect-policy` contracts

**Reviewer V-02 fix:** `effect-policy` uses `(target-scope …)`, NOT
`(target …)`. The valid fields per `structure-effect.ts:82–89` are:
`description`, `severity`, `target-scope`, `forbid`, `allow-only`,
`fix-hint`. Anything else returns E0359. Also `exempt` is NOT a valid
field of `effect-policy`; the exemption mechanism is the separate
`effect-suppression` form (Step 4.4).

#### `CORE_IS_PURE_OR_FS_READ`

```lisp
(effect-policy CORE_IS_PURE_OR_FS_READ
  (description "@stele/core/src is the pure-ish layer. fs.read is allowed (for loadContract). fs.write, time, random, network, env, process, child-process are all forbidden — they belong in the cli or backends, not in core.")
  (severity error)
  (target-scope "packages/core/src/**::*")
  (allow-only "fs.read" "crypto.hash")
  (fix-hint "[A] If your function needs a side effect, move it out of @stele/core into @stele/cli. [B] If you believe core legitimately needs a new effect, propose adding it to the allow-only set via design propose."))
```

(Note: `allow-only` lists the WHITELISTED effects. The absence of
`pure` is intentional — a pure node already has `effects: []` and
doesn't need to clear a whitelist.)

#### `MANIFEST_WRITES_ARE_ATOMIC`

```lisp
(effect-policy MANIFEST_WRITES_ARE_ATOMIC
  (description "Only writeAtomic may have effect=fs.write inside @stele/core. Any other function with fs.write is a violation — manifests must be atomic.")
  (severity error)
  (target-scope "packages/core/src/manifest/**::*")
  (forbid "fs.write")
  (fix-hint "[A] Route the write through writeAtomic. [B] If you legitimately need a non-atomic write inside core/manifest, file an effect-suppression with a security review note."))
```

(Note: `writeAtomic`/`writeManifest`/`writeHashManifest` are
suppressed via 3 separate `effect-suppression` entries in Step 4.4 —
NOT inline in the policy.)

#### `HOOK_NO_NETWORK`

```lisp
(effect-policy HOOK_NO_NETWORK
  (description "Hook scripts must not have network effects — a hook that contacts the internet is an exfiltration risk.")
  (severity error)
  (target-scope "packages/claude-code-plugin/scripts/*.js::*")
  (forbid "network")
  (fix-hint "[A] Remove the network call. [B] If telemetry is needed, it must be opt-in and gated behind a STELE_TELEMETRY env var documented in claude-code-plugin.md."))
```

#### `GENERATOR_NO_NETWORK_OR_CHILD_PROCESS`

```lisp
(effect-policy GENERATOR_NO_NETWORK_OR_CHILD_PROCESS
  (description "stele generate must be self-contained — no network, no shelling out. Determinism requires that generation is hermetic.")
  (severity error)
  (target-scope "packages/cli/src/commands/generate.ts::*")
  (forbid "network" "child-process")
  (fix-hint "[A] Move the shell-out / network call out of generate. The CLI orchestrator may do this; the generator may not."))
```

### Step 4.4 — `effect-suppression` for the 3 legitimate fs.write sites in @stele/core/manifest

**Reviewer V-03 / V-09 fix:**
- Field name is `suppresses`, not `suppress` (`structure-effect.ts:92`).
- Suppression targets should include arity to disambiguate (e.g.
  `writeAtomic(2)`); arity is optional in the pattern matcher but
  recommended for unambiguous targeting.

We need 3 separate `effect-suppression` blocks (one per legitimate
caller) — `effect-suppression` targets a single NodeId, not a glob:

```lisp
(effect-suppression
  (target "packages/core/src/manifest/hash-manifest.ts::writeAtomic(2)")
  (suppresses "fs.write" "time" "random")
  (severity info)
  (reason "Canonical atomic writer for the manifest. Uses Date.now() + randomBytes(8) to build an atomic temp-file name; the fs.write is the actual atomic rename. Lone exemption in @stele/core; documented since Round 7 CORE_ENGINE_PURITY allowlist."))

(effect-suppression
  (target "packages/core/src/manifest/manifest.ts::writeManifest(3)")
  (suppresses "fs.write")
  (severity info)
  (reason "Wraps writeAtomic. The fs.write effect is inherited; this suppression marks it as expected and audited."))

(effect-suppression
  (target "packages/core/src/manifest/hash-manifest.ts::writeHashManifest(2)")
  (suppresses "fs.write")
  (severity info)
  (reason "Wraps writeAtomic. Same rationale as writeManifest above."))
```

**Note on arity:** confirm each function's parameter count by reading
the source before locking the contract. If `writeAtomic` takes 2 args,
the NodeId is `writeAtomic(2)`. Wrong arity → suppression doesn't bind
→ policy fires on a function we meant to exempt. If unsure, omit the
arity suffix — the pattern matcher treats it as a wildcard.

### Step 4.5 — Negative tests

4 tests:

1. `test_core_is_pure_rejects_random` — inject `Math.random()` into a
   non-manifest core file, assert policy fires.
2. `test_manifest_writes_are_atomic_rejects_raw_writefile` — inject
   `writeFile(...)` (not `writeAtomic`) into a manifest file, assert
   policy fires.
3. `test_hook_no_network_rejects_fetch` — inject `fetch(...)` into a
   hook script, assert policy fires.
4. `test_generator_no_child_process_rejects_execfile` — inject
   `execFile(...)` into generate.ts, assert policy fires.

### Step 4.6 — Re-lock + verify

```
pnpm build
node packages/cli/dist/index.js generate --force
node packages/cli/dist/index.js lock --reason "Phase 4: effect-declarations + 4 effect-policy + 1 effect-suppression"
node packages/cli/dist/index.js check     # ~70 invariants
```

## Acceptance criteria

- [ ] 1 `effect-declarations` block (10 effect names)
- [ ] ~40 public functions in @stele/core annotated with `@stele:effects`
- [ ] 4 `effect-policy` contracts
- [ ] 1 `effect-suppression` for hash-manifest.ts
- [ ] 4 negative tests
- [ ] `stele check` exit 0
- [ ] `CORE_ENGINE_PURITY` Python checker STILL passes (defence-in-depth)

## Dependencies

- **Phase 0**: required
- Phase 1: helpful

## Rollback strategy

Per-policy revert. Each policy is in its own commit.

## Sub-agent execution prompt

```
Read docs/design/self-dogfooding/README.md and
docs/design/self-dogfooding/phase-4-effect-policy.md.

Confirm Phase 0 is complete.

Land in order:
  1. Step 4.1 effect-declarations (1 commit)
  2. Step 4.2 annotations in batches of ~10 functions per commit
  3. Steps 4.3 + 4.4 policies + suppression (1 commit per policy)
  4. Step 4.5 negative tests (1 commit)
  5. Step 4.6 lock + check

Don't annotate functions in batches > 10 — risk of cascading effect
propagation errors.
```
