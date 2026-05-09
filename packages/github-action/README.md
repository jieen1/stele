# @stele/github-action

A GitHub Action that runs Stele contract checks on pull requests and emits:

- inline GitHub annotations (capped at 50 errors + 50 warnings),
- a single live-updating PR comment with the full violation list and witness data,
- a non-zero action exit when violations cross the configured `fail-on` threshold.

## Inputs

| Input | Default | Description |
|---|---|---|
| `mode` | `check` | `check` or `generate`. `lock` is intentionally NOT supported (auto-lock would silently approve drift). |
| `diff-from` | `${{ github.event.pull_request.base.sha }}` | Base ref forwarded to `stele check --diff-from`. |
| `fail-on` | `error` | Severity threshold: `error`, `warning`, or `all`. |
| `annotate` | `true` | Emit GitHub annotations on the PR diff. |
| `pr-comment` | `true` | Post / update a single PR comment containing the violation summary. |
| `token` | _(required)_ | A GitHub token with `pull-requests:write` and `checks:write`. Pass `${{ secrets.GITHUB_TOKEN }}`. |

## Usage

```yaml
permissions:
  pull-requests: write
  checks: write

jobs:
  stele:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - uses: stelehq/stele-action@v0
        with:
          mode: check
          fail-on: error
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Modes

### `check`

Runs `stele check --json --diff-from <ref>`.

| CLI exit | Action behaviour |
|---|---|
| `0` | Action passes; comment shows "Passing". |
| `2` (generated drift) | Annotations + PR comment + `setFailed`. |
| `3` (manifest drift) | `setFailed` with `stele lock` instructions. |
| Any other non-zero | `setFailed` with stderr surfaced. |

The `fail-on` input filters which severities cause the Action to fail; non-failing
violations are still annotated and listed in the PR comment.

### `generate`

Runs `stele generate`. Exit code 2 → `setFailed("Generated test files drifted ...")`.

### `lock` _(rejected)_

`mode: lock` is intentionally rejected with a helpful error. Auto-lock from CI
would silently approve manifest drift, defeating the purpose of locking. Run
`stele lock` locally after review, or wire a manual `workflow_dispatch` job.

## Schema

The Action consumes the `ViolationReport` schema documented in
[`docs/spec/cli-output.md`](../../docs/spec/cli-output.md). All field reads use
the canonical names: `rule_id`, `location.path`, `cause.summary`,
`cause.detail`, `cause.failure_witness`.
