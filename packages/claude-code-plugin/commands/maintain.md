# /stele:maintain

Create a periodic maintenance summary for contract upkeep:

```bash
stele maintenance-summary --from main --output .stele/maintenance/summary.md
```

Use this manually when you want an explicit review. The plugin's `Stop` hook also runs this automatically after material source edits and asks the agent once to decide whether new durable knowledge should become an add-only proposal. Convert durable new project knowledge into add-only proposals with `stele propose invariant --apply`. Do not modify or delete existing contract rules without explicit user review.
