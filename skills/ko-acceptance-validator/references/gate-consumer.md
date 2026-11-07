# What a gate ingests

The verdict is advisory. The skill emits and persists a signal, and nothing here merges. The gate stays advisory.

`node <skill-dir>/scripts/gate.mjs <verdict.json> <feature-path> <sha> [expected-fingerprint]` loads the verdict, validates it, recomputes the artifact hash, compares the SHA, re-derives the verdict from its recorded parts, and prints its decision. It always exits 0.

## Ingestion contract

- **A schema-valid artifact or nothing.** It never parses prose: markdown in, `would-block: unparseable` out, no throw.
- **Build-stage verdicts only.** A `stage: spec` verdict is a plan-time judgment, so it is `would-block: wrong-stage` whatever its PASS, SHA or hash.
- **`would-pass` needs a clean build PASS bound to this commit.** It must be valid, `stage: build`, `PASS`, carry a `target_url`, match the commit and the current `.feature` bytes, and earn its PASS from its own recorded parts. Anything else is `would-block: <reason>`, such as `sha-mismatch`, `artifact-drift`, `not-earned`, `stale-fingerprint` or `unevaluated: <reason>`.

## Posture table

| Verdict | Posture | Gate behavior |
|---|---|---|
| `PASS` | convergent | Prints `would-pass`. |
| `CONCERNS` | advisory residual | Surfaced, never auto-fixed. Prints `would-block: concerns`. |
| `REJECT` | divergent | Never auto-fixed. Prints `would-block: reject`. |
| `unevaluated` | fail-closed | No browser, an unreachable target, a skipped route, a malformed artifact, missing evidence or insufficient intent all land here, never a silent PASS. |
