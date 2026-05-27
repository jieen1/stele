# What YOU Need To Do — npm Publish

This is the **interactive / browser-side** half of the publish. The CLI-side automation is in `scripts/publish-after-login.sh`. You do steps 1–4 in a browser + terminal, then run the script.

Total time: **15–30 minutes** (mostly waiting for email verification + setting up 2FA).

---

## Step 1 — Create an npm account (browser)

1. Open https://www.npmjs.com/signup
2. Pick a username (this becomes **your** npm identity — `@<username>` — independent of the `@stele` scope we'll create next).
3. Use a real email you can check immediately.
4. Click the verification link npm emails you. **Without this, publishes are rejected.**

## Step 2 — Enable 2FA (browser, strongly recommended)

1. Sign in at https://www.npmjs.com
2. Go to your **Account Settings → Two-Factor Authentication**
3. Pick **Auth & writes** (this is the npm default for publishing accounts; requires OTP for every `npm publish`).
4. Scan the QR code with your authenticator app (Google Authenticator, 1Password, Authy — any TOTP app).
5. **Save the recovery codes somewhere safe.** If you lose your phone and don't have these, you lose the @stele org.

**Cost of skipping 2FA:** anyone who steals your npm token can publish a malicious 0.1.1 to all 17 @stele packages.

## Step 3 — Create the `@stele` organization (browser)

1. Sign in, go to https://www.npmjs.com/org/create
2. **Org name: `stele`** (exactly this, lowercase; this is what `@stele/cli` etc. reference)
3. Tier: **Free** (public packages only — costs $0)
4. After creation, you're automatically the owner.

If `stele` is already taken (very unlikely — I probed and got 404), pick `stele-hq` or similar AND tell me; I need to rename `@stele/*` to `@stele-hq/*` across 17 packages.

## Step 4 — Log the CLI session in (terminal)

In **this terminal** (the one running on your machine, where you have the Stele repo):

```bash
cd /home/bot/project/stele
npm login --scope=@stele --auth-type=web
```

This opens a browser tab asking you to authorize this machine. Approve it. The CLI session is now linked to your npm account.

Verify:

```bash
npm whoami
# should print your npm username

npm org ls stele
# should show YOU as the only member (admin)
```

If `npm whoami` errors, the login didn't complete — re-run step 4.

## Step 5 — Run the publish wrapper

```bash
./scripts/publish-after-login.sh
```

The script does 12 steps and prompts twice:

1. **"Create + push tag v0.1.0?"** — say `y` unless you have a reason not to.
2. **"Proceed with real publish?"** — say `y` after reading the summary.

Then it will run `node scripts/publish-npm.mjs --no-provenance --tag latest --access public`, which calls `npm publish` 17 times.

### During publish: OTP prompts

Each `npm publish` may pop up:

```
This operation requires a one-time password.
Enter OTP: _____
```

Open your authenticator app, type the 6-digit code, hit enter. Up to 17 times total. **Don't reuse the same code** — wait for it to refresh between prompts if needed.

If you ran `npm login` very recently npm may bundle multiple publishes under one OTP — you might only be prompted 1–3 times total.

### If something fails mid-publish

The script stops at the first error. Common cases:

| Error | What to do |
|---|---|
| `EOTP` (OTP timeout / wrong code) | Re-run the script. Already-published packages will fail with `E409` (version conflict); the script's tarball loop will need to skip those — we have **no auto-resume** currently. Manually `npm unpublish @stele/<name>@0.1.0` for each already-published one, then re-run. |
| `E403 You cannot publish over the previously published versions` | A package already exists at 0.1.0. Either `npm unpublish` it (within 72h) or bump to 0.1.1. |
| `EAUTHIP` (IP blocked / rate limited) | Wait 10 minutes, retry. |
| Connection issues via proxy | `~/.npmrc` has `http://127.0.0.1:7890` set. Make sure the proxy is up. |
| `E401 You must be logged in to publish packages` | Re-run `npm login`. |

## Step 6 — After publish succeeds

The script's last steps automatically:
- Smoke test: `npm install @stele/cli` from `/tmp` and run `npx stele --version`
- Verify all 17 packages return `0.1.0` from `npm view`
- Print the next-action commands

**Then tell me** "publish 完成了" and I will:
- Update `README.md` Quickstart so npm-registry is the **primary** install path (current state: bash-script is primary, npm-registry is "future")
- Update `docs/guides/installation.md` to swap path order
- Strip the "Before public publish, use packed tarballs" preambles from all 5 language guides
- Commit + push: `docs: post-publish — npm-registry is primary install`
- Optionally help you draft GitHub release notes at `https://github.com/stelehq/stele/releases/new?tag=v0.1.0`

## What if I can't do this right now?

Everything is staged. The dry-run is green. The wrapper script will work whenever you're ready. The only state on your end is:

- npm account exists
- 2FA configured
- `@stele` org owned
- `npm login` session active in the terminal

Until those four hold, the script step 1–2 will tell you what's missing.

## Rollback (within 72 hours of publish)

If something is wrong with the published packages (broken bin, missing files, etc.):

```bash
for p in architecture-core call-graph-core core backend-python backend-go backend-rust backend-java backend-typescript agent-hooks trace-evaluator type-state-evaluator effect-evaluator type-driven-evaluator mcp-server cli claude-code-plugin github-action; do
  npm unpublish "@stele/$p@0.1.0"
done
```

After 72h you can't unpublish. You'd have to publish 0.1.1.

## Cost summary

- npm account: **free**
- `@stele` org (public packages): **free**
- Publishing: **free**
- Total cost of step 1–6: **$0**

The only "cost" is your time (~15 min interactive + ~5 min watching the script).
