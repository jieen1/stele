# /stele:add

Use this command when the user wants to author or extend protected contract material.

1. Ask what kind of addition is needed: invariant, checker, import, or generated output change.
2. If a checker implementation is needed, run:

```bash
stele add-checker <checker-id>
```

3. Present the emitted checker block or contract snippet to the user for approval.
4. Route the actual protected-file change through the contract authoring flow instead of editing `contract/**/*.stele`, `contract/checker_impls/**/*`, `contract/.manifest.json`, or `tests/contract/**/*` directly.
