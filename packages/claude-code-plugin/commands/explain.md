# /stele:explain

Explain a specific invariant, checker-backed rule, or generated test target by running:

```bash
stele explain <id>
```

Use `stele explain <id> --json` when machine-readable output is more useful.

Use the CLI output to answer with the exact invariant source, generated test path, dependencies, rationale, and checker linkage for the requested ID. If the rule no longer describes intended behavior, stop and ask the user to review the contract change instead of editing protected files directly.
