# Pre-flight Checklist — `pnpm release:publish` for v0.1.0

This is the human-only step. **Do NOT run `pnpm release:publish` unless every box below is checked.**

## 1. npm scope ownership

```bash
# Confirm the @stele scope exists and you can publish to it.
npm whoami
npm access list packages @stele     # should list 17 placeholders OR be empty (first publish)
npm org ls stele                    # confirms you're an admin of the org
```

If `@stele` isn't yet an npm org:
1. Sign in at https://www.npmjs.com.
2. Create org `stele` (free tier OK for public packages).
3. Add yourself as `admin` and `developer`.
4. Re-run `npm whoami` from CLI to be sure the local CLI session is on the same user.

## 2. CLI login + tokens

```bash
# Interactive login (browser-OTP flow recommended).
npm login --scope=@stele --auth-type=web

# Verify a publish token is in your ~/.npmrc:
grep //registry.npmjs.org/:_authToken ~/.npmrc
```

Alternative for CI: create an automation token at https://www.npmjs.com/settings/<you>/tokens, set `--otp` for 2FA, and put it in CI secrets.

## 3. Working tree state

```bash
cd /home/bot/project/stele
git status                         # must be clean
git rev-parse --abbrev-ref HEAD    # main
git pull --ff-only                 # sync with origin/main
```

If dirty: commit or stash before publishing. The release script reads the working tree at pack time.

## 4. Gate runs (the script will repeat these, but a pre-flight catches surprises early)

```bash
pnpm build                                      # exit 0
pnpm -r run typecheck                           # exit 0
pnpm -r run test                                # exit 0
node packages/cli/dist/index.js check           # exit 0
pnpm test:packed-adoption                       # exit 0 — Python e2e
```

If any fails: STOP. Fix the failure, commit, push, re-run from the top.

## 5. Tag the release

```bash
git tag -s v0.1.0 -m "stele v0.1.0 — initial public npm release"
git push origin v0.1.0
```

`-s` requires GPG; drop to `-a` if you don't sign tags. The tag is used by `--require-git-tag-version` if you opt in (see step 7).

## 6. Final dry-run

```bash
pnpm release:dry-run
```

Must end with `OK dry-run completed for 17 Stele package(s).` If any package fails: STOP. The publish script is the gate; do NOT bypass it.

## 7. Real publish

```bash
# Recommended: provenance OFF for the first manual publish.
# Re-enable later via GHA OIDC.
node scripts/publish-npm.mjs --no-provenance --tag latest --access public
```

If you have a tagged release commit and want the script to enforce version-tag match:

```bash
node scripts/publish-npm.mjs --no-provenance --require-git-tag-version
```

Expect:

- 17 separate `npm publish` invocations.
- Each may prompt for an OTP code from your 2FA app — supply when asked.
- Total wall time: 2-5 minutes depending on network.

If interrupted partway:

- Already-published packages cannot be re-published at the same version. Either:
  - `npm unpublish @stele/<name>@0.1.0` within 72 hours and restart, OR
  - Bump all 17 to `0.1.1` and retry.
- The script does not currently support resume. If a partial publish happens, capture which packages succeeded (`npm view @stele/<name> version`), then unpublish them within 72h.

## 8. Post-publish smoke test

```bash
# In a fresh tmpdir, not the Stele repo:
mkdir /tmp/stele-smoke && cd /tmp/stele-smoke
npm init -y
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele --version                # → 0.1.0
npx stele init --language python   # scaffolds contract/ + tests/contract/
cat stele.config.json | grep targetLanguage
```

All four must succeed. If any fails, the package is on the registry but broken — same severity as a failed publish. Decide between forward-fix (0.1.1) or `npm unpublish` (within 72h).

## 9. Update install docs

After verified publish:

- [ ] `README.md` — move npm-registry install above the bash-script path; label the script as "From-source / contributor install."
- [ ] `docs/guides/installation.md` — same swap; remove "Path E (future)" labeling.
- [ ] `docs/guides/{python,typescript,go,rust,java}-integration.md` — drop "Before public publish, use packed tarballs" preambles.
- [ ] Commit with message `docs: post-publish — npm-registry is now the primary install path` and push.

## 10. Announce

- [ ] GitHub release notes at `https://github.com/stelehq/stele/releases/new?tag=v0.1.0`.
- [ ] Optional: tweet / post / Discord.

## Rollback

If anything goes wrong:

```bash
# Within 72 hours of publish:
for pkg in architecture-core call-graph-core core backend-python backend-go backend-rust backend-java backend-typescript agent-hooks trace-evaluator type-state-evaluator effect-evaluator type-driven-evaluator mcp-server cli claude-code-plugin github-action; do
  npm unpublish @stele/$pkg@0.1.0
done
```

After 72 hours: bump to 0.1.1 across all 17 in lockstep and re-publish.

## What this checklist does NOT cover

- Setting up GitHub Actions for automated publishing (do this AFTER manual 0.1.0 is on the registry; cross-reference `docs/contributing/release.md`).
- Provenance / sigstore signing (enable via OIDC in GHA workflow; manual first publish uses `--no-provenance` because local sigstore requires extra config).
- Marketplace listing for `@stele/github-action` (that's a GitHub Marketplace flow, not npm).
- Bumping past 0.1.0. Once 0.1.0 ships, future releases follow `docs/contributing/release.md`.
