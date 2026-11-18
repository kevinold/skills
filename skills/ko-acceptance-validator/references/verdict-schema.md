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
| `evidence_redacted` | boolean | Build stage, deployed target only. `true` only with at least one evidence item, every screenshot blurred and checked, every text capture from `capture.mjs`, and findings and notes that quote no record content. `attach-evidence.mjs` refuses evidence from a deployed target, or from a verdict that names no target, without it. |
| `judge_fingerprint` | string | `<modelId>@<sha256(judge file)>`. |
| `reason` | string | Required when `verdict` is `unevaluated`. |
| `dimensions` | object | Four entries keyed by dimension name. |
| `routes[]` | array | `{ route, result, reason }`, `result` is `Pass`, `Fail` or `Skip`. |
| `scenarios[]` | array | `{ id, kind, dimension, route, status }`, one row per scenario. See below. |
| `manifest` | object \| null | Build stage only. See below. |
| `generated_at` | string | ISO timestamp. |

Each dimension is `{ status, findings[], evidence[] }`, with `status` one of `PASS`, `CONCERNS`, `REJECT`, `unevaluated` or `not_applicable`.

**Scenario rows.** `id` is the scenario's id from `gherkin.mjs scenarios`. `route` names the one route the outcome was observed on and must be a route that scenario declares. `status` is `held`, `manifested`, `failed` or `unevaluated`. `dimension` and `kind` must match what the scenario declares. A scenario with several routes still has one row, and each of its other routes must appear in `routes[]`.

**Required dimensions.** At build, all four, each needing at least one matching scenario on an exercised route and non-empty `evidence[]`. At spec, `workflow-fit` and `intent-match`; the other two are `not_applicable`.

**Execution manifest.** `{ "verified": true, "sha": "<sha>", "artifact_hash": "<hash>", "routes": [{ "route": "/orders", "result": "Pass" }] }`. Honored only when bound to this run: the same sha and hash, and a route table covering `routes[]` with matching results.

## Inputs you write

Write drafts and the manifest under `.tmp/acceptance/`. `findings[]` and `evidence[]` are lists of strings.

- **`sha`** is the full `git rev-parse HEAD`, everywhere: `compose`, the manifest and `capture.mjs --sha`.
- **`modelId`** is the model id your host reports for this session, or `unknown` if it reports none. Use the same string for every run so a verdict keeps its fingerprint.

A spec draft needs no `routes` or `scenarios`:

```json
{
  "stage": "spec",
  "artifact_path": "docs/plans/reorder-plan.feature",
  "dimensions": {
    "workflow-fit": { "status": "PASS", "findings": ["I start this from the order I'm looking at."], "evidence": [] },
    "intent-match": { "status": "CONCERNS", "findings": ["I asked to reorder everything; this only covers one item."], "evidence": [] },
    "legibility": { "status": "not_applicable", "findings": [], "evidence": [] },
    "convention-fit": { "status": "not_applicable", "findings": [], "evidence": [] }
  }
}
```

A build draft adds `target_url`, the route table and one row per scenario, with all four dimensions judged:

```json
{
  "stage": "build",
  "artifact_path": "docs/plans/reorder-plan.feature",
  "target_url": "http://localhost:3000",
  "dimensions": {
    "workflow-fit": { "status": "PASS", "findings": [], "evidence": [".tmp/acceptance/evidence/abc1234/orders.png"] },
    "legibility": { "status": "PASS", "findings": [], "evidence": [".tmp/acceptance/evidence/abc1234/orders.png"] },
    "intent-match": { "status": "PASS", "findings": [], "evidence": [".tmp/acceptance/evidence/abc1234/the-api-lists-it.txt"] },
    "convention-fit": { "status": "PASS", "findings": [], "evidence": [".tmp/acceptance/evidence/abc1234/orders.png"] }
  },
  "routes": [{ "route": "/orders/:id", "result": "Pass", "reason": "" }],
  "scenarios": [{ "id": "reorder-starts-from-the-order", "kind": "good", "dimension": "workflow-fit", "route": "/orders/:id", "status": "held" }]
}
```

An early exit needs only a reason. Pass `-` as the artifact when no file exists; at build, pass the file when it does:

```json
{ "stage": "spec", "dimensions": {}, "reason": "missing-judge" }
```

## Compose precedence (fail-closed)

Applied top to bottom. The first matching rung sets the verdict, and rung 2 collects every reason.

| # | Condition | Result |
|---|---|---|
| 1 | Any dimension `REJECT`, or any scenario `manifested` or `failed` | **REJECT** |
| 2 | The draft states a `reason` (listed first) | **unevaluated** |
| 2 | An unknown `stage` or dimension status | **unevaluated** |
| 2 | Build: no `target_url` | **unevaluated** |
| 2 | The artifact fails lint (`malformed-artifact: <line>: <message>`) | **unevaluated** |
| 2 | No artifact exists | **unevaluated**, `artifact_hash: null` |
| 2 | A required dimension missing, `unevaluated` or `not_applicable` | **unevaluated** |
| 2 | Build: a required dimension with no matching scenario or no evidence | **unevaluated** |
| 2 | Build: a parsed scenario missing from the verdict, a row the artifact lacks, a repeated row, a row on an undeclared route, or a row whose `dimension` or `kind` differs from the scenario's | **unevaluated** |
| 2 | Build: a declared `@route:` absent from `routes[]` | **unevaluated** |
| 2 | Build: a `routes[]` row `Skip`, `Fail` or unknown | **unevaluated** |
| 2 | Build: a scenario not `held` or `manifested`, or on an unexercised route | **unevaluated** |
| 2 | Build: a missing or unbound execution manifest | **unevaluated** |
| 3 | Any dimension `CONCERNS` | **CONCERNS** |
| 4 | Otherwise | **PASS** |

Reasons you state on a draft: `missing-judge`, `insufficient-intent`, `missing-artifact`, `no-target`, `browser-unavailable`, `target-unreachable`, `target-stale`. Any other string is accepted and shown as written.

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
