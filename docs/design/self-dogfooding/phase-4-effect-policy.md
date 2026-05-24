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

```lisp
(effect-declarations
  (effect pure)
  (effect fs.read)
  (effect fs.write)
  (effect time)         ; Date.now, performance.now, setTimeout
  (effect random)       ; Math.random, crypto.random*
  (effect env)          ; process.env access
  (effect network)      ; http / fetch / dns
  (effect crypto.hash)  ; deterministic hashing (createHash is pure given input)
  (effect process)      ; process.exit, process.cwd, process.argv
  (effect child-process)) ; execFile, spawn
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

#### `CORE_IS_PURE_OR_FS_READ`

```lisp
(effect-policy CORE_IS_PURE_OR_FS_READ
  (description "@stele/core/src is the pure-ish layer. fs.read is allowed (for loadContract). fs.write, time, random, network, env, process, child-process are all forbidden — they belong in the cli or backends, not in core.")
  (severity error)
  (target "packages/core/src/**::*")
  (allow-only "pure" "fs.read" "crypto.hash")
  (fix-hint "[A] If your function needs a side effect, move it out of @stele/core into @stele/cli. [B] If you believe core legitimately needs a new effect, propose adding it to the allow-only set via design propose."))
```

#### `MANIFEST_WRITES_ARE_ATOMIC`

```lisp
(effect-policy MANIFEST_WRITES_ARE_ATOMIC
  (description "Only writeAtomic may have effect=fs.write inside @stele/core. Any other function with fs.write is a violation — manifests must be atomic.")
  (severity error)
  (target "packages/core/src/manifest/**::*")
  (forbid "fs.write")
  (exempt "packages/core/src/manifest/hash-manifest.ts::writeAtomic" (reason "the canonical atomic writer"))
  (exempt "packages/core/src/manifest/manifest.ts::writeManifest" (reason "wraps writeAtomic"))
  (exempt "packages/core/src/manifest/hash-manifest.ts::writeHashManifest" (reason "wraps writeAtomic"))
  (fix-hint "[A] Route the write through writeAtomic. [B] If you legitimately need a non-atomic write inside core/manifest, file an exemption with a security review note."))
```

#### `HOOK_NO_NETWORK`

```lisp
(effect-policy HOOK_NO_NETWORK
  (description "Hook scripts must not have network effects — a hook that contacts the internet is an exfiltration risk.")
  (severity error)
  (target "packages/claude-code-plugin/scripts/*.js::*")
  (forbid "network")
  (fix-hint "[A] Remove the network call. [B] If telemetry is needed, it must be opt-in and gated behind a STELE_TELEMETRY env var documented in claude-code-plugin.md."))
```

#### `GENERATOR_NO_NETWORK_OR_CHILD_PROCESS`

```lisp
(effect-policy GENERATOR_NO_NETWORK_OR_CHILD_PROCESS
  (description "stele generate must be self-contained — no network, no shelling out. Determinism requires that generation is hermetic.")
  (severity error)
  (target "packages/cli/src/commands/generate.ts::*")
  (forbid "network" "child-process")
  (fix-hint "[A] Move the shell-out / network call out of generate. The CLI orchestrator may do this; the generator may not."))
```

### Step 4.4 — `effect-suppression` for hash-manifest.ts

```lisp
(effect-suppression
  (target "packages/core/src/manifest/hash-manifest.ts::writeAtomic")
  (suppress "fs.write" "time" "random")
  (reason "The single canonical writer for the manifest. Uses Date.now() + randomBytes(8) to build an atomic temp-file name; the fs.write is the actual atomic rename. This is the lone exemption in @stele/core; documented since Round 7 CORE_ENGINE_PURITY allowlist."))
```

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
