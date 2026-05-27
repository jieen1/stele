#!/usr/bin/env bash
# publish-after-login.sh — run AFTER you've completed `npm login --scope=@stele --auth-type=web`.
#
# This script wraps everything the agent can't do interactively:
#   1. Verify you're logged in and the @stele scope is accessible.
#   2. Verify the @stele org exists (it must — see PUBLISH-CHECKLIST.md step 1).
#   3. Re-run the dry-run as a final sanity check.
#   4. Optionally tag the release commit.
#   5. Execute the real publish with --no-provenance (recommended for first manual publish).
#   6. Run a post-publish smoke test from /tmp.
#   7. Print the README-update commands.
#
# Usage:
#   ./scripts/publish-after-login.sh                  # interactive, asks for confirmation before publish
#   ./scripts/publish-after-login.sh --yes            # non-interactive, publishes without asking
#   ./scripts/publish-after-login.sh --skip-tag       # don't create the v0.1.0 git tag
#
# This script assumes you've already done:
#   - Created an npm account at https://www.npmjs.com/signup
#   - Created the @stele organization at https://www.npmjs.com/org/create
#   - Run `npm login --scope=@stele --auth-type=web`
#   - Run `npm whoami` and confirmed it returns your username
#
# OTP: most steps will prompt for a 2FA code if your account has 2FA enabled.
# Keep your authenticator app open.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
EXPECTED_VERSION="0.1.0"
TAG="v${EXPECTED_VERSION}"

YES=0
SKIP_TAG=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --skip-tag) SKIP_TAG=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

prompt_confirm() {
  if [ "${YES}" -eq 1 ]; then return 0; fi
  read -p "$1 [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]]
}

step() { printf "\n\033[1;34m== %s ==\033[0m\n" "$1"; }
ok()   { printf "\033[1;32mOK\033[0m   %s\n" "$1"; }
err()  { printf "\033[1;31mERR\033[0m  %s\n" "$1" >&2; }

cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
step "1. npm login state"
# ---------------------------------------------------------------------------
NPM_USER=""
if NPM_USER="$(npm whoami 2>/dev/null)"; then
  ok "logged in as: ${NPM_USER}"
else
  err "not logged in to npm"
  cat <<EOM

Run this first (opens browser):
    npm login --scope=@stele --auth-type=web

Then re-run this script.
EOM
  exit 1
fi

# ---------------------------------------------------------------------------
step "2. @stele scope accessibility"
# ---------------------------------------------------------------------------
# `npm access list packages @stele` only works once at least one package is
# published. For first publish we instead probe the org page.
if npm org ls stele 2>/dev/null | head -1 >/dev/null; then
  ok "@stele organization exists; you have membership"
else
  err "cannot list @stele organization members"
  cat <<EOM

You must create the @stele organization first:
  1. Sign in at https://www.npmjs.com
  2. Go to https://www.npmjs.com/org/create
  3. Name: stele   (must be exactly this)
  4. Type: Free (for public packages)
  5. Add yourself as Admin + Developer

After the org is created, re-run this script.

EOM
  exit 1
fi

# ---------------------------------------------------------------------------
step "3. working tree clean"
# ---------------------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  err "working tree is dirty:"
  git status --short
  exit 1
fi
ok "working tree clean"

# ---------------------------------------------------------------------------
step "4. on main branch and synced"
# ---------------------------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "${BRANCH}" != "main" ]; then
  err "not on main (currently: ${BRANCH})"; exit 1
fi
git fetch origin --quiet
BEHIND="$(git rev-list HEAD..origin/main --count)"
AHEAD="$(git rev-list origin/main..HEAD --count)"
if [ "${BEHIND}" -ne 0 ]; then
  err "main is behind origin/main by ${BEHIND} commits — pull first"
  exit 1
fi
if [ "${AHEAD}" -ne 0 ]; then
  err "main is ahead of origin/main by ${AHEAD} commits — push first"
  exit 1
fi
ok "on main, fully synced with origin"

# ---------------------------------------------------------------------------
step "5. CC-3 pre-flight (build / typecheck / stele check / pytest)"
# ---------------------------------------------------------------------------
pnpm build >/dev/null 2>&1
ok "pnpm build"
pnpm -r run typecheck >/dev/null 2>&1
ok "pnpm typecheck"
node packages/cli/dist/index.js check >/dev/null 2>&1
ok "stele check (exit 0)"
.venv/bin/pytest tests/contract -q >/dev/null 2>&1
ok "pytest tests/contract"

# ---------------------------------------------------------------------------
step "6. release:dry-run final check"
# ---------------------------------------------------------------------------
DRY_OUTPUT="$(pnpm release:dry-run 2>&1 | tail -1)"
if [[ "${DRY_OUTPUT}" != *"OK dry-run completed for 17 Stele package(s)."* ]]; then
  err "dry-run did not complete cleanly:"
  echo "${DRY_OUTPUT}"
  exit 1
fi
ok "dry-run green for all 17 packages"

# ---------------------------------------------------------------------------
step "7. tag the release commit"
# ---------------------------------------------------------------------------
if [ "${SKIP_TAG}" -eq 1 ]; then
  ok "tag step skipped (--skip-tag)"
else
  if git rev-parse "${TAG}" >/dev/null 2>&1; then
    ok "tag ${TAG} already exists"
  else
    if prompt_confirm "Create + push tag ${TAG} on this commit ($(git rev-parse --short HEAD))?"; then
      git tag -a "${TAG}" -m "stele v${EXPECTED_VERSION} — initial public npm release"
      git push origin "${TAG}"
      ok "tag ${TAG} created and pushed"
    else
      ok "tag step declined; continuing without tag"
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "8. confirmation before real publish"
# ---------------------------------------------------------------------------
cat <<EOM

About to publish 17 @stele/* packages to https://registry.npmjs.org
at version ${EXPECTED_VERSION}.

This is IRREVERSIBLE except via \`npm unpublish\` within 72 hours.

You will be prompted for a 2FA OTP code MULTIPLE TIMES (once per package).
Keep your authenticator app open.

Logged in as: ${NPM_USER}
Tag: $(git describe --tags --exact-match 2>/dev/null || echo "(none on this commit)")
Commit: $(git rev-parse HEAD)

EOM

if ! prompt_confirm "Proceed with real publish?"; then
  err "aborted by user"
  exit 1
fi

# ---------------------------------------------------------------------------
step "9. publish"
# ---------------------------------------------------------------------------
# --no-provenance for the first manual publish: provenance requires sigstore
# + GHA OIDC, which we'll set up in a follow-up CI workflow.
node scripts/publish-npm.mjs --no-provenance --tag latest --access public
ok "publish script returned 0"

# ---------------------------------------------------------------------------
step "10. post-publish smoke test"
# ---------------------------------------------------------------------------
SMOKE_DIR="$(mktemp -d -t stele-smoke-XXXXXX)"
(
  cd "${SMOKE_DIR}"
  npm init -y >/dev/null 2>&1
  npm install --save-dev @stele/cli @stele/claude-code-plugin >/dev/null 2>&1
  VER="$(npx stele --version 2>/dev/null | tr -d '[:space:]')"
  if [ "${VER}" = "${EXPECTED_VERSION}" ]; then
    ok "smoke test: npx stele --version → ${VER}"
  else
    err "smoke test: expected ${EXPECTED_VERSION}, got '${VER}'"
    exit 1
  fi
  npx stele init --language python >/dev/null 2>&1
  if [ -f stele.config.json ]; then
    ok "smoke test: stele init scaffolded stele.config.json"
  else
    err "smoke test: stele init did not write stele.config.json"
    exit 1
  fi
)
rm -rf "${SMOKE_DIR}"

# ---------------------------------------------------------------------------
step "11. all 17 packages visible on registry"
# ---------------------------------------------------------------------------
PACKAGES=(
  architecture-core call-graph-core core
  backend-python backend-go backend-rust backend-java backend-typescript
  agent-hooks
  trace-evaluator type-state-evaluator effect-evaluator type-driven-evaluator
  mcp-server cli claude-code-plugin github-action
)
for p in "${PACKAGES[@]}"; do
  RESP="$(npm view "@stele/${p}" version 2>/dev/null || true)"
  if [ "${RESP}" = "${EXPECTED_VERSION}" ]; then
    printf "\033[1;32m  ✓\033[0m @stele/%s@%s\n" "$p" "${EXPECTED_VERSION}"
  else
    printf "\033[1;31m  ✗\033[0m @stele/%s — got '%s'\n" "$p" "${RESP}"
  fi
done

# ---------------------------------------------------------------------------
step "12. next steps"
# ---------------------------------------------------------------------------
cat <<EOM

ALL DONE. Stele v${EXPECTED_VERSION} is live on the public npm registry.

Users can now install via:
    npm install --save-dev @stele/cli @stele/claude-code-plugin

Next, update install docs so npm-registry is the primary install path:

    # Run the agent on:
    #   "publish 完成了 帮我把 README/installation guide 改成 npm 注册表作为主路径"

GitHub release notes:
    https://github.com/stelehq/stele/releases/new?tag=${TAG}

Rollback (within 72 hours, if needed):
    for p in ${PACKAGES[@]}; do npm unpublish "@stele/\$p@${EXPECTED_VERSION}"; done

EOM
