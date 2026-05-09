# Pre-commit Hook Setup

Stele integrates with the [pre-commit](https://pre-commit.com/) framework so that
contract drift is caught before changes leave a developer's machine. This guide
walks through installing pre-commit, generating a Stele-aware
`.pre-commit-config.yaml`, and troubleshooting common issues.

## 1. Install pre-commit

`pre-commit` is distributed via pip and is independent of the Stele CLI.

```bash
# Recommended (isolated):
pipx install pre-commit

# Alternative (system / venv):
pip install pre-commit
```

Verify the install:

```bash
pre-commit --version
```

## 2. Generate the Stele hook config

Run `stele init --pre-commit` from your project root:

```bash
stele init --language python --pre-commit
# or, for an existing project that already has a Stele config:
stele init --language python --pre-commit
```

This creates (or updates) `.pre-commit-config.yaml` with two hooks:

| Hook id           | Command            | Triggers on                                    |
| ----------------- | ------------------ | ---------------------------------------------- |
| `stele-generate`  | `npx stele generate` | `contract/**/*.stele` and `stele.config.json` |
| `stele-check`     | `npx stele check`    | every commit                                   |

The command is **idempotent**: re-running it never duplicates Stele hooks. If
your `.pre-commit-config.yaml` already contains other hooks, only the missing
Stele entries are appended. The exact behavior:

| Existing state                                            | What `stele init --pre-commit` does          |
| --------------------------------------------------------- | -------------------------------------------- |
| File does not exist                                       | Create from template                         |
| File exists, no `repo: local` block                       | Append a `repo: local` block with both hooks |
| File exists, `repo: local` block but no Stele hooks       | Add both Stele hooks to the existing block   |
| File exists, only one Stele hook (e.g., `stele-generate`) | Add the missing one (`stele-check`)          |
| File exists, all Stele hooks already present              | Skip with an "already installed" message     |

> Stele intentionally does **not** install a `stele-lock` pre-push hook. Locking
> the manifest must remain a deliberate human action; an automatic lock would
> silently approve manifest drift.

## 3. Wire the git hooks

After the YAML is in place, install the git hook scripts:

```bash
pre-commit install
```

Optionally validate against the entire repository once:

```bash
pre-commit run --all-files
```

## 4. Windows notes

- `npx` shim resolution under `cmd.exe` can fail to find the binary when called
  from `pre-commit`. If you see "command not found" or "npx is not recognized",
  run pre-commit from **Git Bash** or **WSL** instead. PowerShell with the
  Node.js installer's recommended PATH usually works as well.
- `pre-commit` rewrites the config with LF line endings on first run. Keep
  `.pre-commit-config.yaml` checked in with LF (`* text=auto eol=lf` in
  `.gitattributes`) to avoid spurious diffs between Windows and POSIX users.
- File globs in the config (such as `^(contract/.*\.stele|stele\.config\.json)$`)
  are POSIX regexes; pre-commit normalizes paths to forward slashes before
  matching, so no Windows-specific changes are needed.

## 5. Coexistence with other hook managers

If you already use [Husky](https://typicode.github.io/husky/) or
[lefthook](https://github.com/evilmartians/lefthook), pick **one** hook
framework. Mixing them produces overlapping `.git/hooks/pre-commit` files and
unpredictable ordering.

- To migrate from Husky to pre-commit: remove `husky/_/pre-commit` and run
  `pre-commit install` again.
- To keep Husky: invoke `npx stele check && npx stele generate` from your
  Husky `pre-commit` script instead of running `stele init --pre-commit`.

## 6. Debugging a failing hook

When a Stele hook reports a failure during commit, you usually want a verbose
re-run:

```bash
pre-commit run stele-check --all-files --verbose
pre-commit run stele-generate --all-files --verbose
```

Common fixes:

- `stele-check` exits with code 4 (generated drift): re-run `stele generate`
  and commit the regenerated tests.
- `stele-check` exits with code 3 (manifest drift): inspect the change, then
  run `stele lock --reason "<why>"` after a deliberate review.
- `stele-check` exits with code 5 (config error): fix the `stele.config.json`
  or contract file referenced in the error message.

## 7. Out of scope

`stele init --pre-commit` deliberately **does not**:

- Install `pre-commit` itself; that is left to the developer's environment.
- Add a `pre-push` hook (manifest locking is human-only).
- Track hook coverage statistics.
