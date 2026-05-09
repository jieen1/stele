# Migration v0.1 → v0.2

This page documents the user-visible behavior changes in Stele v0.2 and the
small adjustments required for existing projects. Most projects need no
changes.

## EP05: Incremental `stele generate` (default on)

`stele generate` now caches per-file hashes in
`contract/.cache/hash-manifest.json`. Subsequent runs skip writing files whose
generated content has not changed. Output is byte-equal to the v0.1 full
regenerate path; existing CI workflows continue to work without modification.

### What's new

- New flags on `stele generate`:
  - `--force`  — ignore the cache, regenerate every file (and refresh the
    cache).
  - `--no-cache` — neither read nor write the cache. Use in CI runs where
    the cache should not be persisted.
- New subcommands:
  - `stele cache clean`  — delete `contract/.cache/hash-manifest.json`.
  - `stele cache info`   — show cache stats (entries, size, generated_at).

### Cache directory

Stele writes incremental state to `contract/.cache/`. We recommend adding it
to `.gitignore`; the file is derived state and changes on every regenerate.

```gitignore
# Stele incremental generation cache (v0.2+)
contract/.cache/
```

If you prefer to commit the manifest (e.g., to share warm caches with
teammates) you can leave it tracked. Behavior is identical either way.

### Cache invalidation triggers

The cache is invalidated (forcing a full regenerate of every file) when any of
the following changes:

- the parsed `stele.config.json` (excluding volatile fields like
  `_generated_at`);
- the `targetLanguage`/backend used at generation time;
- the Stele CLI version (`stele_version`);
- the operator registry (`operator_registry_hash` in
  `packages/core/src/registry/operators.ts`).

Within a valid cache window, only files whose `transitive_hash` changed are
written to disk. `transitive_hash = SHA-256(own_hash || sort(deps_transitive_hash))`,
so editing an imported `.stele` file correctly invalidates every file that
imports it.

### When to use which flag

| Situation                                       | Flag           |
|-------------------------------------------------|----------------|
| Daily local edit-loop                           | (default)      |
| Suspect cache corruption / want clean rebuild   | `--force`      |
| Throw-away CI step that should not write cache  | `--no-cache`   |

### Concurrency: undefined behavior

Running multiple `stele generate` processes in the same project simultaneously
is **undefined behavior** in v0.2. Atomic writes guarantee no partial files,
but concurrent runs may produce a manifest that disagrees with on-disk
artifacts. CI should call `stele generate` sequentially.

If you observe spurious tamper alerts (`stele check` complains about files
that were just regenerated), run `stele generate --force` to rebuild the
cache.

A future release (`v0.5+`) is expected to add filesystem locking on
`contract/.cache/.lock`.

### Rollback

To restore v0.1 behavior on every run, pass `--force` (or run
`stele cache clean` once, after which the next `stele generate` performs a
full regenerate). To opt out of caching entirely:

```bash
stele cache clean
stele generate --no-cache
```

### Performance expectation

| Project size  | v0.1 full regen | v0.2 incremental (1 file changed) |
|---------------|-----------------|-----------------------------------|
| 10 .stele     | ~0.3 s          | ~0.05 s                           |
| 100 .stele    | ~2.5 s          | ~0.15 s                           |
| 500 .stele    | ~12 s           | ~0.4 s                            |

Acceptance gate (PRD §6.4): a 100-file project with a single edited file must
run in ≤ 10% of full regenerate wall time.
