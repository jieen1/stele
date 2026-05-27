#!/usr/bin/env bash
# install-stele-local.sh — bash equivalent of local-packages/install-stele-local.ps1.
#
# Installs the packed @stele tarballs from `local-packages/` into the current
# application directory and wires npm scripts (stele:init, stele:generate,
# stele:lock, stele:check, stele:list). Verifies the CLI resolves via npx,
# npm exec, and `npm run stele -- --version`.
#
# Usage (from the application's repo root):
#   /path/to/stele/scripts/install-stele-local.sh
#
# Or from the Stele repo itself:
#   ./scripts/install-stele-local.sh /path/to/your/app
#
# Requirements on the target host:
#   - node >= 18, npm >= 9 (any modern LTS)
#   - python >= 3.10 with pytest installed (for the Python backend path)

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
PACK_DIR="${REPO_ROOT}/local-packages"
EXPECTED_VERSION="0.1.0"

PROJECT_DIR="${1:-$(pwd)}"
if [ ! -d "${PROJECT_DIR}" ]; then
  echo "ERROR: target project dir does not exist: ${PROJECT_DIR}" >&2
  exit 1
fi
PROJECT_DIR="$( cd "${PROJECT_DIR}" && pwd )"

TARBALLS=(
  "stele-core-0.1.0.tgz"
  "stele-backend-python-0.1.0.tgz"
  "stele-cli-0.1.0.tgz"
  "stele-claude-code-plugin-0.1.0.tgz"
)

# 1. Verify tarballs exist. If they don't, try packing them.
need_pack=0
for tgz in "${TARBALLS[@]}"; do
  if [ ! -f "${PACK_DIR}/${tgz}" ]; then
    need_pack=1
    break
  fi
done

if [ "${need_pack}" -eq 1 ]; then
  echo "[stele] one or more tarballs missing in ${PACK_DIR}; packing now..."
  (
    cd "${REPO_ROOT}"
    pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install
    pnpm build
    mkdir -p "${PACK_DIR}"
    for pkg in core backend-python cli claude-code-plugin; do
      ( cd "packages/${pkg}" && pnpm pack --pack-destination "${PACK_DIR}" >/dev/null )
    done
  )
fi

for tgz in "${TARBALLS[@]}"; do
  if [ ! -f "${PACK_DIR}/${tgz}" ]; then
    echo "ERROR: still missing tarball after pack: ${PACK_DIR}/${tgz}" >&2
    exit 1
  fi
done

# 2. Ensure the target project has a package.json.
cd "${PROJECT_DIR}"
if [ ! -f "package.json" ]; then
  echo "[stele] creating package.json in ${PROJECT_DIR}"
  npm init -y >/dev/null
fi

# 3. Clean any prior stele bin shims so npm reinstalls them deterministically.
BIN_DIR="${PROJECT_DIR}/node_modules/.bin"
if [ -d "${BIN_DIR}" ]; then
  for shim in stele stele.cmd stele.ps1; do
    rm -f "${BIN_DIR}/${shim}"
  done
fi

# 4. Install all tarballs in one npm call (--force to bypass peer warnings).
echo "[stele] installing tarballs into ${PROJECT_DIR}..."
install_args=(install --save-dev --force)
for tgz in "${TARBALLS[@]}"; do
  install_args+=("${PACK_DIR}/${tgz}")
done
npm "${install_args[@]}"

# 5. Repair the bin shim if npm didn't write a plain `stele` for POSIX.
CLI_ENTRY="${PROJECT_DIR}/node_modules/@stele/cli/dist/index.js"
if [ ! -f "${CLI_ENTRY}" ]; then
  echo "ERROR: missing CLI entry after install: ${CLI_ENTRY}" >&2
  exit 1
fi
mkdir -p "${BIN_DIR}"
cat > "${BIN_DIR}/stele" <<'SHIM'
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node" "$basedir/../@stele/cli/dist/index.js" "$@"
else
  exec node "$basedir/../@stele/cli/dist/index.js" "$@"
fi
SHIM
chmod +x "${BIN_DIR}/stele"

# 6. Add convenience npm scripts to package.json.
echo "[stele] adding npm scripts to package.json..."
node - "${PROJECT_DIR}/package.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.scripts = pkg.scripts || {};
const stele = "node ./node_modules/@stele/cli/dist/index.js";
const want = {
  "stele": stele,
  "stele:init": `${stele} init --language python`,
  "stele:generate": `${stele} generate`,
  "stele:generate:force": `${stele} generate --force`,
  "stele:lock": `${stele} lock`,
  "stele:check": `${stele} check`,
  "stele:list": `${stele} list`,
};
for (const [k, v] of Object.entries(want)) {
  pkg.scripts[k] = v;
}
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
console.log("[stele] wrote scripts:", Object.keys(want).join(", "));
NODE

# 7. Verify the CLI resolves via every documented form.
verify_cli() {
  local label="$1"; shift
  local out
  out="$("$@" 2>&1 || true)"
  if [ "${out//[$'\t\r\n ']/}" != "${EXPECTED_VERSION}" ]; then
    # Loosen: accept "contains the version" for the npm-run form which echoes
    # the underlying command.
    if [[ "${out}" != *"${EXPECTED_VERSION}"* ]]; then
      echo "ERROR: ${label} did not resolve the local Stele CLI. Got: ${out}" >&2
      exit 1
    fi
  fi
  echo "[stele] verified: ${label} -> ${EXPECTED_VERSION}"
}

verify_cli "npx stele --version"           npx stele --version
verify_cli "npx -- stele --version"        npx -- stele --version
verify_cli "npx stele version"             npx stele version
verify_cli "npm exec -- stele --version"   npm exec -- stele --version
verify_cli "npm run stele -- --version"    npm run stele -- --version

cat <<EOM

[stele] Local install complete in ${PROJECT_DIR}.

Next steps:

  npm run stele:init                  # scaffolds contract/ + tests/contract/
  npm run stele:generate              # CDL -> generated pytest suite
  python -m pytest tests/contract -q  # run the generated tests
  npm run stele:lock -- --reason "initial contract baseline"
  npm run stele:check                 # exit 0 = clean

To register the Claude Code plugin (optional, agent-side):
  see docs/guides/claude-code-plugin.md § "Register the plugin"

EOM
