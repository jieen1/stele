# /stele:why

Explain a rule id or check-report fingerprint by running:

```bash
stele why <rule-id-or-fingerprint>
```

Use this when `stele check` fails or when a rule is unclear. The output gives the cause, source location, fix direction, and agent guidance for whether to repair source, add a new rule, or ask the user to review a contract change.
