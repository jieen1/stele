# npm Publish Plan — v0.1.0 Public Release

**Status:** plan (2026-05-26)
**Owner:** main agent
**Tracking ID:** `npm-publish-v0.1.0`
**Predecessor:** `docs/design/self-dogfooding-closeout/` (the 7-closeout effort that landed all 14 mechanisms self-dogfooded — prerequisite for "we trust the tool enough to publish it")

## Goal

Take the 11 publishable `@stele/*` packages from pre-publish state to **`@stele/*@0.1.0` on the public npm registry**, so the install paths documented in `docs/guides/installation.md` and the README's Quickstart actually work via `npm install --save-dev @stele/cli @stele/claude-code-plugin`.

After this lands:

- `npx stele init --language python` works after a plain `npm install`.
- The 4 local-tarball install paths (bash script, PS1, manual tarball, from-source) become *optional* developer alternatives, not the only way in.
- The README's npm-registry quickstart stops being aspirational.

## Acceptance

- [ ] `pnpm release:dry-run` exits 0 with no `workspace:*` residue in any packed manifest.
- [ ] `npm view @stele/cli version` returns `0.1.0` against the public registry.
- [ ] All 11 packages resolvable from a clean directory: `npm install -g @stele/cli` works, `npx stele --version` prints `0.1.0`.
- [ ] `pnpm test:packed-adoption` still green (it builds from local source, but the version pins should match).
- [ ] README updated so the bash-script install path is the **backup**, not the primary.

## The 11 publishable packages

Currently `scripts/publish-npm.mjs::publishPackageDirs` lists 11, but **6 critical dependencies are missing from that list**. Live current state:

| # | Package | In publish list? | CLI depends on it? | Notes |
|---|---|---|---|---|
| 1 | `@stele/core` | ✅ | ✅ | engine |
| 2 | `@stele/backend-python` | ✅ | ✅ | pytest backend |
| 3 | `@stele/backend-go` | ✅ | ✅ | Phase A only |
| 4 | `@stele/backend-rust` | ✅ | ✅ | Phase A only |
| 5 | `@stele/backend-java` | ✅ | ✅ | Phase A only |
| 6 | `@stele/backend-typescript` | ✅ | ✅ | full Phase B |
| 7 | `@stele/agent-hooks` | ✅ | — | shared hook SDK |
| 8 | `@stele/mcp-server` | ✅ | ✅ | MCP bridge |
| 9 | `@stele/cli` | ✅ | self | the `stele` binary |
| 10 | `@stele/claude-code-plugin` | ✅ | — | hooks + slash cmds |
| 11 | `@stele/github-action` | ✅ | — | GitHub Action distro |
| **12** | **`@stele/architecture-core`** | ❌ **BLOCKER** | ✅ | DDD layering primitives |
| **13** | **`@stele/call-graph-core`** | ❌ **BLOCKER** | ✅ | extern resolver |
| **14** | **`@stele/trace-evaluator`** | ❌ **BLOCKER** | ✅ | Phase B trace |
| **15** | **`@stele/type-state-evaluator`** | ❌ **BLOCKER** | ✅ | Phase B type-state |
| **16** | **`@stele/effect-evaluator`** | ❌ **BLOCKER** | ✅ | Phase B effect |
| **17** | **`@stele/type-driven-evaluator`** | ❌ **BLOCKER** | ✅ | Phase B type-driven |

All 6 missing packages already have:
- `private: false`
- `license: MIT`
- `repository: github:stelehq/stele`
- `files: ["dist"]`
- `publishConfig: { access: "public" }`

They are publishable; they were just left out of the script's array. **Total publish count after fix: 17 packages.**

If we publish only the 11 in the current list, `npm install @stele/cli` will **fail** at install time because npm can't resolve `@stele/architecture-core`, `@stele/call-graph-core`, etc. on the registry.

## Plan steps

### Step 1 — Audit + write down what gates

This document. ✅

### Step 2 — Fix the publish-npm script's package list

`scripts/publish-npm.mjs::publishPackageDirs` gains the 6 missing rows. Order matters for `pnpm pack` to rewrite `workspace:*` correctly — depend-on-X packages must pack after X. Topological order:

```
architecture-core
call-graph-core
core
backend-python, backend-go, backend-rust, backend-java, backend-typescript
agent-hooks
trace-evaluator, type-state-evaluator, effect-evaluator, type-driven-evaluator
mcp-server
cli                            ← depends on most of the above
claude-code-plugin             ← depends on cli (peer or runtime)
github-action                  ← depends on cli
```

(In practice `pnpm pack` resolves `workspace:*` against the workspace at pack time regardless of array order; we still sort topologically for readability + reproducible output.)

### Step 3 — Dry-run + fix everything that fails

```bash
pnpm release:dry-run
```

This runs (in order):
1. `pnpm build` — must succeed (already does).
2. `pnpm -r run typecheck` — must succeed (already does).
3. `pnpm -r run test` — must succeed (~2000 TS tests + ~48 pytest contract + ~125 negative).
4. `node packages/cli/dist/index.js check --format json` — must exit 0 (it does today).
5. `pnpm pack` each of the 17 packages → tarball under tmp dir.
6. `verifyPackedManifest` each tarball — REJECTS any `workspace:*` residue.
7. `npm publish --dry-run` each tarball — REJECTS any name conflict, missing field, OTP requirement.

Known potential gates we may hit:
- npm scope `@stele` may not be registered yet → owner pre-registers via `npm org create stele` or equivalent.
- 2FA / OTP — `--otp <code>` flag needs to be threaded by user during real publish (dry-run skips).
- Provenance — script defaults `provenance: true`, which requires sigstore + GHA OIDC. Local dry-run will warn; for the first manual publish we'll `--no-provenance` and set up provenance in the GHA workflow later.
- Files-field omissions — some packages may need `dist/templates`, `dist/runtime`, or `.claude-plugin/` to be explicitly included.

For each failure: fix at source, re-run, repeat. Anti-pattern: hand-rolling a workaround inside the script. CC-12 still applies — if the contract fires, fix the source.

### Step 4 — Verify dry-run is fully clean

`pnpm release:dry-run` exits 0, no warnings other than the documented provenance one.

`scripts/verify-packed-adoption.mjs` still green (it runs against locally packed tarballs; should be unaffected).

### Step 5 — User-gated publish

I cannot run `pnpm release:publish` for the user:
- It requires the user's npm credentials (logged-in `~/.npmrc` with a publish token for `@stele/*`).
- It may require an OTP / 2FA code at run time.
- It permanently consumes name @ version pairs on the public registry — irreversible.

The user must run it. I prepare:
- A pre-flight checklist (logged-in, OTP ready, on tagged commit, …).
- The exact command to run.
- A post-publish verification script.

### Step 6 — Verify the published packages

After user runs `pnpm release:publish`:

```bash
# Smoke test: install in a fresh tmpdir.
mkdir /tmp/stele-smoke && cd /tmp/stele-smoke
npm init -y
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele --version          # → 0.1.0
npx stele init --language python
node -e "console.log(require('@stele/cli/package.json').version)"
```

If this fails, the package is on the registry but unusable — same severity as a failed publish. Either fix forward with `0.1.1` or `npm unpublish` (72-hour window).

### Step 7 — Update install docs

After verified publish:

- README Quickstart: move the npm-registry path **above** the bash-script path. Re-label the script as "From-source / contributor install" rather than "Path A".
- `docs/guides/installation.md`: swap path order, mark npm registry as **active** not future.
- `docs/guides/python-integration.md` and 4 sibling guides: their existing `npm install --save-dev @stele/cli @stele/claude-code-plugin` lines become accurate; remove the "Before public publish, use packed tarballs" preambles.
- Push.

## Anti-patterns to avoid (inherited from closeout plan)

- **Don't bypass the script's manifest verifier.** If `verifyPackedManifest` rejects, fix the source. Don't add a `--skip-verify` flag.
- **Don't disable provenance** as the long-term posture. Document the trade-off if needed for the first publish.
- **Don't manually publish individual packages out of band.** The script is the audit trail; ad-hoc `npm publish` from a single package dir is forbidden because it skips the gates.
- **Don't bump versions to 0.1.1 just to redo a failed publish.** Fix the script, retry 0.1.0. Once 0.1.0 is on the registry, **only then** consider 0.1.1.
- **Don't change `package.json::version` without bumping all 17 in lockstep.** The lockstep rule comes from CLAUDE.md.

## Rollback

If `pnpm release:publish` partially succeeds (e.g., 5 of 17 packages publish, then OTP times out):

- `npm unpublish @stele/<name>@0.1.0` within 72 hours wipes them.
- After 72 hours, must bump to 0.1.1 and re-publish a fixed version.
- The `scripts/publish-npm.mjs` should be made resumable (skip already-published tarballs); current state is unclear. Verify before real publish.

## Sub-agent execution

This work doesn't need a sub-agent. Main agent owns the flow:

1. Edit the publishPackageDirs array.
2. Run `pnpm release:dry-run`.
3. Read failures, fix at source, repeat.
4. When green, hand off to user for `pnpm release:publish`.

If `pnpm release:dry-run` surfaces something architectural (e.g., the script can't resume mid-publish), I may dispatch a focused sub-agent for that fix. Otherwise sequential at main level.
