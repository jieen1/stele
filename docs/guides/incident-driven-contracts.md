# Incident-driven contracts

Turn a production incident plus its fix into a **locked, provenance-tagged contract invariant** — with a machine-checked proof that the candidate test actually has teeth (fails before the fix, passes after).

The loop is deterministic and hard-testable: the probabilistic "write a candidate invariant + test" step is an **injected input** (`--draft-from <file|->`, or the calling agent via the MCP tool), never a live LLM/API call inside the CLI. Everything else — git resolution, the teeth proof, the apply/generate/lock — is reproducible.

## The loop

```
incident happens
   │
   ▼
human/agent supplies { one-sentence intent, the fix commit, a DRAFT }
   │     DRAFT = { invariantCdl, negativeTest, testFilename? }
   ▼
stele incident draft   →  validates + records the draft under .stele/incident/<id>/
   │
   ▼
stele incident teeth   →  runs the negative test at <fix>^ and <fix> in isolated
   │                       worktrees; verdict TEETH_PROVEN iff it FAILS at the
   │                       parent AND PASSES at the fix
   ▼
human approves
   │
   ▼
stele incident approve →  hard teeth gate → atomic apply → generate → lock,
                          with provenance tags + a signed approval record, and a
                          COMMITTED provenance record at contract/provenance/<id>.json
   │
   ▼
stele incident reverify → re-derive the locked verdict from git on demand
                          (exit 0 reproduced / 2 contradicted / 1 could-not-reproduce)
```

`.stele/incident/` and `.stele/proofs/` are **scratch**: never hashed into the manifest, never added to the protected globs. The `contract/provenance/<id>.json` record, by contrast, is **committed** — it carries the SHAs + the negative-test bytes so anyone with the repo can re-run the proof.

## Re-deriving a verdict (`reverify`)

The teeth proof is computed once. To let an auditor — or CI on a fresh clone — confirm a locked invariant was genuinely proven, `stele incident reverify` re-creates the two worktrees from the committed record's SHAs, re-runs the embedded negative test, and re-derives the verdict:

```bash
stele incident reverify --id <id>     # one incident
stele incident reverify --all         # every committed provenance record (CI)
```

Three outcomes, with distinct exit codes so an absent toolchain or a missing SHA is never confused with a tamper:

- **reproduced (exit 0)** — the re-run agrees with the recorded verdict.
- **contradicted (exit 2)** — the re-run ran but disagrees, or the record's own hashes don't match its bytes (tamper, or the proof no longer holds). CI should fail.
- **could-not-reproduce (exit 1)** — the proof could not be re-run at all (a SHA absent from this clone, an absent toolchain). Distinct from a contradiction.

The exit-code core (parent fails, fix passes) is stable; the `parentBiteClass` refinement depends on the runner's failure output staying classifiable, so a `contradicted` arising from a runner-version output change should prompt re-running `teeth`, not an assumption of tamper.

> Wiring `contract/provenance/**` into the protected globs (manifest-enforced tamper-evidence) and a dedicated GitHub Action `reverify` mode are planned follow-ons; today a CI job runs `stele incident reverify --all` as a step.

## Worked example

A bug: `add(a, b)` returned `a + a`. The fix commit (`HEAD`) makes it return `a + b`.

### 1. Draft

Supply the intent, the fix revision, and the candidate draft. The draft is JSON:

```json
{
  "invariantCdl": "(invariant add-returns-sum\n  (severity error)\n  (description \"add(a,b) must return a+b\")\n  (assert (checker add_sum_checker)))\n",
  "negativeTest": "from src.calc import add\n\ndef test_add_sum():\n    assert add(1, 2) == 3\n",
  "testFilename": "test_add_sum.py"
}
```

```bash
stele incident draft \
  --intent "add must return the sum of both operands" \
  --fix HEAD \
  --draft-from ./draft.json
```

This derives an `id` from the intent (slugified, path-safe), resolves `<fix>` and `<fix>^` to SHAs via git, dry-run-compiles the `invariantCdl` against your loaded contract, and writes **only** to `.stele/incident/<id>/` (`draft.json` + the candidate test). It never touches a protected path.

Pass `--id <slug>` to choose the id explicitly; pass `--draft-from -` to read the draft from stdin (the bring-your-own-model / agent seam).

### 2. Teeth

```bash
stele incident teeth --id add-must-return-the-sum-of-both-operands
```

Stele creates two isolated detached `git worktree`s — one at `<fix>^`, one at `<fix>` — places the candidate test into each, runs it against that revision's own source, and derives the verdict from exit codes only:

- **`TEETH_PROVEN`** — test FAILS at `<fix>^` AND PASSES at `<fix>`, **and** the parent failure was a real assertion failure (not a collection/compile error).
- **`TEETH_FAILED`** — anything else (vacuous always-pass, fails at both, **or** the parent only failed because the test couldn't be collected/compiled — e.g. it imports a symbol that exists only at `<fix>` — so it never ran its assertions).

Stele records *how* the parent failed in `parentBiteClass` (`assertion` / `collection-or-build` / `unknown` / `passed`). A `collection-or-build` parent failure is **not** teeth: write the negative test against an entry point present at both `<fix>^` and `<fix>`. An output shape Stele can't classify (`unknown`) conservatively falls back to the exit-code rule — it never invents a `TEETH_FAILED`.

The runner is chosen from the candidate test's filename extension, so the gate is language-agnostic:

| extension | runner |
| --- | --- |
| `.py` | `python -m pytest` (`.venv/bin/python`, else `python`/`python3`) |
| `.js` / `.mjs` / `.cjs` | `node --test` |
| `.ts` / `.mts` / `.cts` | `node --test --experimental-strip-types` |
| `.rs` | `cargo test --test <stem>` (placed under `tests/`) |

A missing toolchain is an **infra error (exit 1), never a `TEETH_FAILED` verdict** — a missing interpreter can't masquerade as a toothless test. Go and Java are not yet wired (a single root-level test cannot soundly exercise project code under `go test`/JUnit without a package/build-aware runner); author the test in a supported language or approve with `--teeth-unavailable-reason`.

The proof is written to `.stele/proofs/<id>/teeth.json`:

```json
{
  "verdict": "TEETH_PROVEN",
  "parentSha": "1111111111111111111111111111111111111111",
  "fixSha": "2222222222222222222222222222222222222222",
  "testSha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "invariantSha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  "parentBiteClass": "assertion",
  "parentRun": { "exit": 1, "outputSha256": "aaaa...parent-pytest-output-hash" },
  "fixRun": { "exit": 0, "outputSha256": "bbbb...fix-pytest-output-hash" },
  "producedAtFromGit": "2026-05-29T12:00:00+00:00"
}
```

The proof binds **both** the candidate test (`testSha256`) and the invariant text (`invariantSha256`). At `approve`, Stele re-hashes the current draft's invariant and test and refuses if either changed since the proof — so you cannot prove teeth on a strict invariant and then lock a weaker one.

Its timestamp (`producedAtFromGit`) is the fix commit's committer date (`git show -s --format=%cI`) — never a wall clock — so the proof is byte-reproducible. There is no `producedAt` / `timestamp` wall-clock field by design. Both worktrees are always removed in a `finally`.

### 3. Approve

```bash
STELE_APPROVED_BY="alice@example.com" \
  stele incident approve --id add-must-return-the-sum-of-both-operands
```

`approve` enforces a **hard gate**:

| teeth.json | `--teeth-unavailable-reason` | result |
| --- | --- | --- |
| `TEETH_PROVEN` | — | approve |
| absent / `TEETH_UNAVAILABLE` | given | approve, tagged `teeth:unproven` |
| absent / `TEETH_UNAVAILABLE` | not given | **refuse** (exit 1) |
| `TEETH_FAILED` | anything | **refuse** (exit 1) — a reason can never launder a FAILED verdict |

It also runs the same human-identity gate as `stele design approve`: an interactive TTY, or `STELE_APPROVED_BY` set to a real human-identifying token (containing `@` or `:`, not a denylisted placeholder). `--approved-by <who>` is fed through the identical gate — it does not bypass it.

On approval, the invariant is applied, generated, and locked as **one atomic operation** under an outer snapshot/rollback. The locked invariant carries provenance:

```
(invariant add-returns-sum
  (severity error)
  (description "add(a,b) must return a+b")
  (rationale "... (fix:<fixSha>)")
  (tags "provenance:incident")
  (assert (checker add_sum_checker)))
```

(When approved without a teeth proof, the tags are `(tags "provenance:incident" "teeth:unproven")`.)

A signed approval record is written under `.stele/incident/<id>/` (scratch). If any step of apply/generate/lock fails, the working tree is rolled back exactly to its pre-call state — it never lingers at `stele check` exit-2 (generated drift) or exit-3 (manifest drift). Refusals exit `1`; a mid-sequence failure re-throws its native exit code after rollback. No new exit codes are introduced.

After a successful approve, `stele check` is clean and the new invariant is part of your locked contract.

## Provenance

`(tags "provenance:incident")` is the provenance carrier. It is a convention over the existing CDL `tags` field — there is no new grammar. Find every incident-born invariant with:

```bash
stele list --tag provenance:incident
stele list --tag teeth:unproven      # the subset approved without a proof
```

## Determinism notes

- The only probabilistic step is the **injected draft**. The CLI makes no LLM/API call.
- `teeth.json` is reproducible (timestamp from git, not the clock).
- `.stele/incident/` and `.stele/proofs/` are scratch and are never hashed; the wall-clock-named approval record lives there, so it does not affect manifest stability.
- `@stele/core` stays pure: all git / worktree / child-process / filesystem work lives in the CLI side, never in core.

## MCP

The same three steps are exposed to agents as MCP tools (`incident_draft`, `incident_teeth`, `incident_approve`) — thin wrappers over the same library functions. There, the calling agent *is* the model that supplies the draft.
