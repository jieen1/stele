# Installation — One-Page Start

This is the canonical install doc. After this page you should have:

- The `stele` CLI working in your application repository (`npx stele --version` prints `0.1.0`).
- A scaffolded `contract/main.stele` plus `tests/contract/`.
- (Optional) The Claude Code plugin registered so the agent enforces protected files at edit-time.

## Prerequisites

| Tool | Minimum | Why |
|---|---|---|
| Node.js | 18 LTS | The CLI and all backends are Node packages. |
| npm | 9 | Tarball install path uses `npm install`. |
| Python | 3.10 | Only if you use the Python backend (pytest generated tests). |
| pytest | 7.x | Only if you use the Python backend. |
| Claude Code | latest | Only if you register the editor plugin. |

If you only use a non-Python backend (TypeScript / Go / Rust / Java), you can skip the Python / pytest rows.

## Pick your install path

Stele is **pre-publish in v0.1** — there is no public `npmjs.com/@stele/cli` registry entry yet. Pick the path matching your environment:

| You are… | Use |
|---|---|
| On Linux / macOS with this repo cloned locally | [bash install script](#path-a-bash-install-script-linux--macos) |
| On Windows / PowerShell | [PowerShell install script](#path-b-powershell-install-script-windows) |
| Adopting Stele in a separate app repo | [tarball install (any OS)](#path-c-manual-tarball-install) |
| Trying it on the live Stele repo only | [from-source dev](#path-d-from-source-dev) |
| After v0.1 npm publish | [npm registry install](#path-e-after-npm-publish-future) |

All five paths land at the same `npx stele init --language <X>` step.

---

### Path A — bash install script (Linux / macOS)

```bash
# in your application repo
/path/to/stele/scripts/install-stele-local.sh
```

Or run from the Stele repo against a target app:

```bash
cd /path/to/stele
./scripts/install-stele-local.sh /path/to/your/app
```

The script:

1. Packs `@stele/core`, `@stele/backend-python`, `@stele/cli`, `@stele/claude-code-plugin` if `local-packages/*.tgz` aren't present.
2. `npm install --save-dev` all four tarballs in the target app.
3. Writes `node_modules/.bin/stele` POSIX shim.
4. Adds these npm scripts to the target's `package.json`:
   `stele`, `stele:init`, `stele:generate`, `stele:generate:force`, `stele:lock`, `stele:check`, `stele:list`.
5. Verifies the CLI resolves via every documented form (`npx stele --version`, `npx -- stele --version`, `npx stele version`, `npm exec -- stele --version`, `npm run stele -- --version`).

Output ends with `Stele Local install complete in <dir>`. If any verification fails, the script exits non-zero — read the message.

### Path B — PowerShell install script (Windows)

```powershell
# in your application repo
& 'C:\path\to\stele\local-packages\install-stele-local.ps1'
```

Same behaviour as path A.

### Path C — manual tarball install

If you can't run the script (e.g., you only have the tarballs, not the source):

```bash
cd /path/to/your/app
npm install --save-dev \
  /absolute/path/to/stele-core-0.1.0.tgz \
  /absolute/path/to/stele-backend-python-0.1.0.tgz \
  /absolute/path/to/stele-cli-0.1.0.tgz \
  /absolute/path/to/stele-claude-code-plugin-0.1.0.tgz
```

Then verify:

```bash
npx stele --version          # 0.1.0
npx stele init --language python
```

Add the npm-script convenience wrappers manually (see the `scripts` block the bash script would have written, in [`scripts/install-stele-local.sh`](../../scripts/install-stele-local.sh)).

### Path D — from-source dev

For working *on* Stele itself, not adopting it:

```bash
git clone <repo>
cd stele
pnpm install
pnpm build
pnpm test:packed-adoption   # end-to-end smoke test: pack -> install fixture -> init -> check
```

`pnpm test:packed-adoption` is the canonical "does Stele still install cleanly" guardrail.

### Path E — after npm publish (future)

When v0.1 ships to the npm registry, this becomes:

```bash
npm install --save-dev @stele/cli @stele/claude-code-plugin
npx stele init --language python
```

Until then, paths A–D are the supported ones. The README's Quickstart shows the future shape because it's what users will type once published.

---

## Scaffold contracts in your app

```bash
# pick one
npx stele init --language python      # pytest backend (default for v0.1)
npx stele init --language typescript  # vitest
npx stele init --language go          # go test
npx stele init --language rust        # cargo test
npx stele init --language java        # JUnit 5
```

This writes (in your app, not in Stele itself):

- `stele.config.json` — paths, target language, protected globs
- `contract/main.stele` — your first contract (you edit this)
- `contract/checker_impls/.gitkeep` — where custom Python checkers live
- `tests/contract/conftest.py` (Python) or the equivalent for other languages — application-owned fixture wiring (you edit this to expose your real state)

Optional flags:

- `--ci github-actions` — also writes `.github/workflows/stele.yml`
- `--ci gitlab-ci` — also writes `.gitlab-ci.yml`
- `--pre-commit` — installs a pre-commit hook running `stele check`
- `--dry-run` — prints the files without writing them

## Wire your data (Python backend)

Edit `tests/contract/conftest.py` so `stele_context` returns your application's real state:

```python
import pytest

@pytest.fixture
def stele_context():
    # Return whatever shape your contracts assert against. Stele does NOT
    # invent objects — it reads from this dict.
    return {
        "order": load_sample_order(),
        "user": load_sample_user(),
        "_stele_checkers": {},  # populated by custom checkers, if any
    }
```

For non-Python backends, see the per-language guide:

- [`docs/guides/python-integration.md`](python-integration.md)
- [`docs/guides/typescript-integration.md`](typescript-integration.md)
- [`docs/guides/go-integration.md`](go-integration.md)
- [`docs/guides/rust-integration.md`](rust-integration.md)
- [`docs/guides/java-integration.md`](java-integration.md)

## Generate, run, lock, check

```bash
npx stele generate                   # CDL -> generated tests
python -m pytest tests/contract -q   # run them (Python; substitute for other backends)
npx stele lock --reason "initial baseline"
npx stele check                      # exit 0 = clean
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Clean — all contracts satisfied |
| `2` | Generated drift — committed tests don't match CDL |
| `3` | Tamper detected — manifest hashes don't match |

## Register the Claude Code plugin (optional)

If you use Claude Code, the plugin adds editor-level enforcement (blocks direct writes to `contract/**`, runs `stele check` on `Stop`, etc.).

The plugin tarball was already installed in paths A–C. To activate it:

1. Register the package directory as a project-scoped plugin. Edit (or create) `~/.claude/plugins/installed_plugins.json`:

   ```json
   {
     "stele@local": [
       {
         "scope": "project",
         "projectPath": "/absolute/path/to/your/app",
         "installPath": "/absolute/path/to/your/app/node_modules/@stele/claude-code-plugin"
       }
     ]
   }
   ```

   `projectPath` is your application's repo root. `installPath` is the directory inside `node_modules` where the plugin tarball was extracted (it contains `.claude-plugin/plugin.json`).

2. Enable it in `~/.claude/settings.json`:

   ```json
   {
     "enabledPlugins": {
       "stele@local": true
     }
   }
   ```

3. Restart Claude Code (close + reopen, or start a new session) so the plugin manifest is loaded.

Verify the hooks ran by opening a session in your app and watching for the Stele context injection. See [`docs/guides/claude-code-plugin.md`](claude-code-plugin.md) for the full hook lifecycle reference and slash-command catalog.

### What the plugin enforces (recap)

| Hook | Behaviour |
|---|---|
| `PreToolUse` | Blocks `Write`, `Edit`, `MultiEdit`, write-like `Bash` on `contract/**/*.stele`, `contract/checker_impls/**`, `contract/.manifest.json`, `tests/contract/**`. Fails closed. |
| `Stop` | Runs `stele check` + `python -m pytest tests/contract -q`. Blocks completion if either is red. |
| `SessionStart` / `UserPromptSubmit` | Injects contract context so the agent knows the live rules. |
| `PostToolUse` | Records material source edits for `Stop`-time maintenance review. |

## CI integration

```yaml
# .github/workflows/stele.yml (or .gitlab-ci.yml — `stele init --ci` writes this for you)
- name: Verify contracts
  run: |
    npx stele generate
    python -m pytest tests/contract -q
    npx stele check
```

For focused branch checks:

```bash
npx stele check --diff-from main
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npx stele --version` prints `0.1.0` but `stele init` says "Unsupported language" | The CLI is installed but `--language` value is misspelled. Run `stele init --help` for the supported list. |
| `npm exec stele --version` returns npm's own version | Use `npm exec -- stele --version` (with `--`). `npm exec` consumes flags without it. |
| `stele check` exit 3 immediately after `stele lock` | A non-contract file was modified between `lock` and `check`. Re-run lock with the up-to-date tree, or inspect `contract/.manifest.json` to see which path drifted. |
| Claude Code plugin "does not register" | `installPath` must point at the directory containing `.claude-plugin/plugin.json` (typically `<app>/node_modules/@stele/claude-code-plugin`). |
| `pnpm test:packed-adoption` fails locally on a clean clone | Run `pnpm install` then `pnpm build` first; the adoption test packs from current `dist/`. |

## What you can't do (yet)

- Install via `npm install @stele/cli` from the public registry — **not yet published**. Use one of the local-tarball paths above.
- Use Stele on a non-Node project that has no `package.json`. The CLI binary requires Node ≥ 18; the contracts and generated tests don't, but the CLI itself does.

## Next steps

- [`docs/spec/cdl.md`](../spec/cdl.md) — the CDL language reference (every operator, every error code).
- [`docs/architecture.md`](../architecture.md) — how the layers fit together.
- [`docs/guides/python-integration.md`](python-integration.md) — the Python-specific deep dive (scenarios, fixtures, custom checkers).
- [`docs/guides/claude-code-plugin.md`](claude-code-plugin.md) — full plugin hook reference.
