# Stele npm Release Guide

This repository publishes four public npm packages:

- `@stele/core`
- `@stele/backend-python`
- `@stele/cli`
- `@stele/claude-code-plugin`

The release flow packs each workspace package first, verifies that no `workspace:*` dependency remains in the tarball manifest, then publishes those tarballs to npm in dependency order.

## Prerequisites

The `@stele` npm scope must exist under the npm user or organization that will own the packages.

For a CI release, configure npm trusted publishing for each package:

- Publisher: GitHub Actions
- Organization/user: `jieen1`
- Repository: `stele`
- Workflow filename: `publish.yml`

npm recommends trusted publishing because it uses short-lived OIDC credentials instead of long-lived write tokens. If trusted publishing is unavailable for the first release, create a granular npm automation token with publish rights and store it as the GitHub secret `NPM_TOKEN`, or run the local publish flow after `npm login`.

## Local Dry Run

Run this before any real publish:

```bash
pnpm install --frozen-lockfile
python -m pip install pytest
pnpm test
pnpm typecheck
pnpm lint
pnpm test:packed-adoption
pnpm release:dry-run
```

`pnpm release:dry-run` builds the packages, creates tarballs, checks the packed `package.json` files, and runs `npm publish --dry-run` for each tarball.

## Local Publish

Use this only from a clean, reviewed release commit:

```bash
npm whoami
pnpm release:publish
```

When publishing locally without CI OIDC provenance, pass:

```bash
pnpm release:publish -- --no-provenance
```

The packages are published with the `latest` dist-tag by default. To publish another dist-tag:

```bash
pnpm release:publish -- --tag next
```

## GitHub Actions Publish

The workflow at `.github/workflows/publish.yml` supports:

- manual dry run through `workflow_dispatch`
- manual publish through `workflow_dispatch`
- tag publish on tags matching `v*.*.*`

Recommended release sequence:

```bash
pnpm release:dry-run
git status --short
git tag v0.1.0
git push origin main --tags
```

For tag-triggered publishes, the workflow verifies that the pushed tag, such as `v0.1.0`, matches every package's `version` field before publishing.

After the workflow completes, verify registry availability:

```bash
npm view @stele/core version
npm view @stele/backend-python version
npm view @stele/cli version
npm view @stele/claude-code-plugin version
```

Then verify consumer installation from a clean project:

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele --version
```

## Why Publish Tarballs

Publishing the packed tarballs is intentional. It makes the release artifact explicit and prevents a regression where workspace protocol dependencies such as `workspace:*` leak into npm. The release script refuses to publish if any packed manifest still contains a workspace protocol dependency.
