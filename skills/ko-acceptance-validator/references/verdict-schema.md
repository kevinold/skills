# Verdict schema: `acceptance-verdict/v1`

The prose copy of the contract `scripts/verdict.mjs` enforces.

## Envelope

| Field | Type | Notes |
|---|---|---|
| `schema` | string | Always `acceptance-verdict/v1`. |
| `stage` | `spec` \| `build` | Which stage produced the verdict. |
| `verdict` | `PASS` \| `CONCERNS` \| `REJECT` \| `unevaluated` | `compose` fills it. |
| `sha` | string | Commit SHA the judgment is keyed to. |
| `artifact_hash` | string \| null | sha256 of the exact `.feature` bytes. `null` only when no artifact exists. |
| `artifact_path` | string \| null | Where the `.feature` lives. |
| `target_url` | string \| null | Build stage only. The URL exercised. A non-loopback host counts as a deployed target. |
| `evidence_redacted` | boolean | Build stage, deployed target only. `true` only with at least one evidence item, every screenshot blurred and checked, and every text capture in structure-only form. `attach-evidence.mjs` refuses evidence from a deployed target without it. |
| `judge_fingerprint` | string | `<modelId>@<sha256(judge file)>`. |
| `reason` | string | Required when `verdict` is `unevaluated`. |
| `dimensions` | object | Four entries keyed by dimension name. |
| `routes[]` | array | `{ route, result, reason }`, `result` is `Pass`, `Fail` or `Skip`. |
| `scenarios[]` | array | `{ id, kind, dimension, route, status }`, one row per scenario. See below. |
| `manifest` | object \| null | Build stage only. See below. |
| `generated_at` | string | ISO timestamp. |

Each dimension is `{ status, findings[], evidence[] }`, with `status` one of `PASS`, `CONCERNS`, `REJECT`, `unevaluated` or `not_applicable`.

**Scenario rows.** `id` is the scenario's id from `gherkin.mjs scenarios`. `route` names the one route the outcome was observed on and must be a route that scenario declares. `status` is `held`, `manifested` or `unevaluated`. A scenario with several routes still has one row, and each of its other routes must appear in `routes[]`.

**Required dimensions.** At build, all four, each needing at least one matching scenario on an exercised route and non-empty `evidence[]`. At spec, `workflow-fit` and `intent-match`; the other two are `not_applicable`.

**Execution manifest.** `{ "verified": true, "sha": "<sha>", "artifact_hash": "<hash>", "routes": [{ "route": "/orders", "result": "Pass" }] }`. Honored only when bound to this run: the same sha and hash, and a route table covering `routes[]` with matching results.

## Compose precedence (fail-closed)

Applied top to bottom. The first matching rung sets the verdict, and rung 2 collects every reason.

| # | Condition | Result |
|---|---|---|
| 1 | Any dimension `REJECT` | **REJECT** |
| 2 | The draft states a `reason` (listed first) | **unevaluated** |
| 2 | The artifact fails lint (`malformed-artifact: <line>: <message>`) | **unevaluated** |
| 2 | No artifact exists | **unevaluated**, `artifact_hash: null` |
| 2 | A required dimension missing, `unevaluated` or `not_applicable` | **unevaluated** |
| 2 | Build: a required dimension with no matching scenario or no evidence | **unevaluated** |
| 2 | Build: a parsed scenario missing from the verdict, a row the artifact lacks, a repeated row, or a row on an undeclared route | **unevaluated** |
| 2 | Build: a declared `@route:` absent from `routes[]` | **unevaluated** |
| 2 | Build: a `routes[]` row `Skip`, `Fail` or unknown | **unevaluated** |
| 2 | Build: a scenario not `held` or `manifested`, or on an unexercised route | **unevaluated** |
| 2 | Build: a missing or unbound execution manifest | **unevaluated** |
| 3 | Any dimension `CONCERNS` | **CONCERNS** |
| 4 | Otherwise | **PASS** |

Reasons you state on a draft: `missing-judge`, `insufficient-intent`, `missing-artifact`, `no-target`, `browser-unavailable`, `target-unreachable`, `target-stale`.

`insufficient-intent` and `missing-artifact` imply no artifact exists, so `artifact_hash` must be `null`. `missing-judge` at build keeps the hash of the file that exists.

## Invariants

- Same SHA, hash and fingerprint give the same verdict. `compose` is pure apart from `generated_at`.
- A build verdict never inherits a spec PASS and never validates a drifted artifact.
- A run that dies mid-drive persists nothing, because `persist` is the last judging step.
- A recorded `unevaluated` never re-derives to PASS.

## Persist path

`.tmp/acceptance/<stage>-<sha7>-<hash7>-<fp7>.json`, where `hash7` is `noartf` with no artifact and `fp7` is a digest of the judge fingerprint. A judge or model change re-keys the file instead of overwriting it. `.tmp/acceptance/.gitignore` holds `*`, so the consumer repo needs no ignore edit.

## CLI

`node <skill-dir>/scripts/verdict.mjs <cmd>`:

- `hash <file>` prints the sha256 of the artifact bytes.
- `fingerprint <judge-file> <modelId>` prints the judge fingerprint. A missing judge file hashes as empty bytes.
- `validate <verdict.json>` prints `{ ok, errors }` and exits 1 on invalid.
- `compose <draft.json> <artifact.feature|-> <sha> <fingerprint> [manifest.json]` composes, persists and prints the verdict.
- `rederive <verdict.json>` prints `{ recorded, derived, sha }`. A consumer treats `recorded !== derived` as forged.
