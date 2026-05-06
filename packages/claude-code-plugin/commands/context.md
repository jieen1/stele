# /stele:context

Build focused agent context before editing files that may affect contract behavior:

```bash
stele agent-context --focus <changed-file>
```

Use this before implementation work in a Stele repository. Prefer source-code or fixture repairs before contract edits. New rules may be added through `stele propose invariant --apply`; modifying or deleting existing contract rules requires explicit user review.
